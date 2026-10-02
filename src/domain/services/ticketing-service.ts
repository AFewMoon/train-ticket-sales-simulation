/* 出票领域服务：持久化与事务的收口层。
   v3.0 起算法核心全部委托 src/domain/engine/ticketing-engine（纯函数：快照进/补丁出），
   本服务只负责从事务缓存/仓库构建快照、把补丁落盘——同一套引擎同时服务
   主线程直算与 Web Worker 两条计算路径（行为等价）。
   - 批量事务：beginBatch()/endBatch() 将 orders/queues/events 收敛到内存缓存、
     结束时一次性落盘（教训 #9）；
   - 退票语义（v2.0 起）：状态置 CANCELLED 保留历史，占用统计只认 ISSUED。 */

import type { IRepository } from '../repository';
import type { Train } from '../model/train';
import type { DomainEvent } from '../model/event';
import { Order, OrderStatus } from '../model/order';
import type { QueueFile } from '../../infrastructure/persistence-shapes';
import { BatchScope, directTx, type Tx } from '../../infrastructure/batch-context';
import type { OrderRepository } from '../../infrastructure/order-repository';
import type { TrainService } from './train-service';
import {
  applyPurchase,
  applyRefund,
  applyRefundSimulation,
  applyReconcile,
  capacitySummary as engineCapacitySummary,
  segmentLoad as engineSegmentLoad,
  groupBySeat as engineGroupBySeat,
  EVENTS_CAP
} from '../engine/ticketing-engine';
import { applyPatchToStore } from '../engine/protocol';
import type {
  CapacitySummary,
  CapacitySummaryResult,
  EnginePatch,
  FullScopeSnapshot,
  PatchStore,
  PurchaseResult,
  RefundResult,
  RefundSimResult,
  TrainScopeSnapshot
} from '../engine/protocol';

export { EVENTS_CAP };
export { groupBySeat } from '../engine/ticketing-engine';
export type { PurchaseResult, RefundResult } from '../engine/protocol';

export class TicketingService implements PatchStore {
  private batch: BatchScope | null = null;

  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly trainService: TrainService,
    private readonly queueRepo: IRepository<QueueFile>,
    private readonly eventRepo: IRepository<DomainEvent[]>
  ) {}

  /* ---------- 事务（引擎补丁的事务感知落盘通道） ---------- */

  beginBatch(): void {
    if (!this.batch) this.batch = new BatchScope();
  }

  endBatch(): void {
    if (!this.batch) return;
    this.batch.flush();
    this.batch = null;
  }

  private tx(): Tx {
    return this.batch ?? directTx;
  }

  /* ---------- PatchStore（事务感知，供引擎补丁落盘） ---------- */

  getOrders(): Order[] {
    return this.tx().load(this.orderRepo);
  }

  saveOrders(orders: Order[]): void {
    this.tx().save(this.orderRepo, orders);
  }

  getQueues(): QueueFile {
    return this.tx().load(this.queueRepo);
  }

  saveQueues(q: QueueFile): void {
    this.tx().save(this.queueRepo, q);
  }

  getEvents(): DomainEvent[] {
    return this.tx().load(this.eventRepo);
  }

  saveEvents(events: DomainEvent[]): void {
    this.tx().save(this.eventRepo, events);
  }

  applyPatch(patch: EnginePatch): void {
    applyPatchToStore(this, patch, EVENTS_CAP);
  }

  /* ---------- 快照构建（事务感知） ---------- */

  private buildTrainScope(trainCode: string): TrainScopeSnapshot {
    return {
      train: this.trainService.get(trainCode),
      orders: this.currentOrders().filter((o) => o.trainCode === trainCode).map((o) => o.toDto()),
      queue: this.currentQueues().trains[trainCode]?.map((e) => ({ ...e })) ?? []
    };
  }

  /** 全量快照（仿真引擎/对账入口使用；事务感知；含旧文件形状归一化——教训 #16） */
  buildFullScopeForEngine(): FullScopeSnapshot {
    const qf = this.currentQueues();
    const src: FullScopeSnapshot['queues'] =
      qf.trains && typeof qf.trains === 'object' && !Array.isArray(qf.trains) ? qf.trains : {};
    const queues: FullScopeSnapshot['queues'] = {};
    Object.entries(src).forEach(([code, entries]) => {
      queues[code] = (entries ?? []).map((e) => ({ ...e }));
    });
    return { trains: this.trainService.list(), orders: this.currentOrders().map((o) => o.toDto()), queues };
  }

  /* ---------- 查询（轻量、主线程同步渲染用） ---------- */

  /** 事务感知的当前订单集（兼容别名，测试与对账入口使用） */
  currentOrders(): Order[] {
    return this.getOrders();
  }

  /** 事务感知的当前队列文件（兼容别名） */
  currentQueues(): QueueFile {
    return this.getQueues();
  }


  ordersOfTrain(trainCode: string): Order[] {
    return this.currentOrders().filter((o) => o.trainCode === trainCode);
  }

  waitingOrdersOfTrain(trainCode: string): Order[] {
    return this.ordersOfTrain(trainCode)
      .filter((o) => o.status === OrderStatus.WAITING)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  allWaitingOrders(): Order[] {
    return this.currentOrders().filter((o) => o.status === OrderStatus.WAITING);
  }

  /* ---------- 容量摘要（纯计算委托引擎） ---------- */

  capacitySummary(train: Train, orders: readonly Order[]): CapacitySummary {
    return engineCapacitySummary(train, orders);
  }

  capacityOverview(train: Train, orders: readonly Order[]): CapacitySummaryResult {
    return {
      summary: this.capacitySummary(train, orders),
      issuedCount: orders.filter((o) => o.status === OrderStatus.ISSUED).length,
      waitingCount: orders.filter((o) => o.status === OrderStatus.WAITING).length
    };
  }

  /* ---------- 计算入口（快照 → 引擎 → 补丁） ---------- */

  purchase(trainCode: string, fromIdx: number, toIdx: number): PurchaseResult {
    const outcome = applyPurchase(this.buildTrainScope(trainCode), trainCode, fromIdx, toIdx, Date.now());
    this.applyPatch(outcome.patch);
    return outcome.result;
  }

  refundOrder(orderId: string): RefundResult {
    const order = this.currentOrders().find((o) => o.id === orderId);
    if (!order) return { ok: false, msg: '订单不存在' };
    const outcome = applyRefund(this.buildTrainScope(order.trainCode), orderId, Date.now());
    this.applyPatch(outcome.patch);
    return outcome.result;
  }

  refundSimulation(ratePercent: number): RefundSimResult {
    const outcome = applyRefundSimulation(this.buildFullScopeForEngine(), ratePercent, Date.now());
    this.applyPatch(outcome.patch);
    return outcome.result;
  }

  reconcile(): { fulfilled: number } {
    const outcome = applyReconcile(this.buildFullScopeForEngine(), Date.now());
    this.applyPatch(outcome.patch);
    return outcome.result;
  }

  /** 事件时间线（最新在前） */
  listEvents(limit: number): DomainEvent[] {
    const events = this.getEvents();
    return events.slice(-limit).reverse();
  }

  /* ---------- 兼容保留 ---------- */

  /** 单座位分段占用（委托引擎） */
  segmentLoad(issuedOrders: readonly Order[], stationCount: number, seatNo: number): number[] {
    return engineSegmentLoad(issuedOrders, stationCount, seatNo);
  }

  /** 座位分组（委托引擎） */
  groupBySeat(issuedOrders: readonly Order[]) {
    return engineGroupBySeat(issuedOrders);
  }
}
