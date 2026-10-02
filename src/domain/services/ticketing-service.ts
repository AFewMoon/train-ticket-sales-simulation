/* 出票领域服务（逐单区间适配 · 在线版）：
   —— 规则：候补订单按 createdAt 升序逐单尝试补录，任一座位的目标区间
      [fromIdx, toIdx) 完全空闲即出票到该座位——允许座位存在空洞，最大化座位利用率。
   —— 在线机制：候补队列按车次持久化（tts:queues，时戳有序列表），
      入队 O(log W)、出票 O(1) 移除；退票后自动按时间戳补录。
   —— 座位分配与容量统计只遍历「已占用座位集合」，复杂度与座位数上限解耦（支持 INT_MAX，教训 #20）。
   —— 批量事务：beginBatch()/endBatch() 将 orders/queues/events 的读写收敛到内存缓存、
      结束时一次性落盘（教训 #9）。
   —— 事件流：购票/出票/候补/退票/兑现写入 tts:events（上限 500）。
   —— 退票语义（本次重构变更）：不再删除订单，状态置 CANCELLED 保留历史；
      一切占用统计只认 status === ISSUED。 */

import type { IRepository } from '../repository';
import { uid } from '../model/primitives';
import { Order, OrderStatus } from '../model/order';
import type { Train } from '../model/train';
import { EventType, type DomainEvent } from '../model/event';
import type { QueueEntry, QueueFile } from '../../infrastructure/persistence-shapes';
import { BatchScope, directTx, type Tx } from '../../infrastructure/batch-context';
import type { OrderRepository } from '../../infrastructure/order-repository';
import type { TrainService } from './train-service';

export const EVENTS_CAP = 500;

export type PurchaseResult =
  | { ok: false; msg: string }
  | { ok: true; issued: true; seatNo: number; order: Order }
  | { ok: true; issued: false; position: number; order: Order | null };

export type RefundResult = { ok: false; msg: string } | { ok: true; fulfilled: number };

export interface ProcessResult {
  issued: Order[];
  changed: boolean;
}

/** 单座位空闲区间段统计 */
export interface SeatFreeStat {
  seatNo: number;
  freeSegments: number;
}

export interface CapacitySummary {
  totalSegments: number;
  freeSegments: number;
  perSeat: SeatFreeStat[];
  emptySeatCount: number;
}

export interface CapacitySummaryResult {
  summary: CapacitySummary;
  issuedCount: number;
  waitingCount: number;
}

/** 将已出票订单按座位分组（只含有票座位——未占用座位不占内存与计算量） */
export function groupBySeat(issuedOrders: readonly Order[]): Map<number, Order[]> {
  const bySeat = new Map<number, Order[]>();
  issuedOrders.forEach((o) => {
    if (o.seatNo === null) return;
    const list = bySeat.get(o.seatNo);
    if (list) list.push(o);
    else bySeat.set(o.seatNo, [o]);
  });
  return bySeat;
}

/** 单座位的分段占用（差分数组 + 前缀和），长度 = stationCount - 1 */
export function seatLoad(seatOrders: readonly Order[], stationCount: number): number[] {
  const diff = new Array<number>(stationCount + 1).fill(0);
  seatOrders.forEach((o) => {
    diff[o.fromIdx] = (diff[o.fromIdx] ?? 0) + 1;
    diff[o.toIdx] = (diff[o.toIdx] ?? 0) - 1;
  });
  const load = new Array<number>(Math.max(stationCount - 1, 0)).fill(0);
  let acc = 0;
  for (let i = 0; i < stationCount - 1; i++) {
    acc += diff[i] ?? 0;
    load[i] = acc;
  }
  return load;
}

/** 兼容保留：按座位号统计分段占用 */
export function segmentLoad(issuedOrders: readonly Order[], stationCount: number, seatNo: number): number[] {
  return seatLoad(
    issuedOrders.filter((o) => o.seatNo === seatNo),
    stationCount
  );
}

export class TicketingService {
  private batch: BatchScope | null = null;

  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly trainService: TrainService,
    private readonly queueRepo: IRepository<QueueFile>,
    private readonly eventRepo: IRepository<DomainEvent[]>
  ) {}

  private tx(): Tx {
    return this.batch ?? directTx;
  }

  beginBatch(): void {
    if (!this.batch) this.batch = new BatchScope();
  }

  endBatch(): void {
    if (!this.batch) return;
    this.batch.flush();
    this.batch = null;
  }

  /* ---------- 事务感知读写（对账入口复用） ---------- */

  currentOrders(): Order[] {
    return this.tx().load(this.orderRepo);
  }

  saveOrders(orders: Order[]): void {
    this.tx().save(this.orderRepo, orders);
  }

  currentQueues(): QueueFile {
    return this.tx().load(this.queueRepo);
  }

  saveQueues(q: QueueFile): void {
    this.tx().save(this.queueRepo, q);
  }

  /* ---------- 事件流 ---------- */

  private addEventRecord(ev: DomainEvent): void {
    let events = this.tx().load(this.eventRepo);
    events.push(ev);
    if (events.length > EVENTS_CAP) events = events.slice(events.length - EVENTS_CAP);
    this.tx().save(this.eventRepo, events);
  }

  pushEvent(type: EventType, detail: string, trainCode?: string, orderId?: string): void {
    this.addEventRecord({
      id: uid('e'),
      ts: Date.now(),
      type,
      trainCode: trainCode || '',
      orderId: orderId || '',
      detail
    });
  }

  listEvents(limit: number): DomainEvent[] {
    const events = this.tx().load(this.eventRepo);
    return events.slice(-limit).reverse();
  }

  /* ---------- 候补队列（在线持久化，时戳有序） ---------- */

  private getQueue(q: QueueFile, trainCode: string): QueueEntry[] {
    let queue = q.trains[trainCode];
    if (!queue) {
      queue = [];
      q.trains[trainCode] = queue;
    }
    return queue;
  }

  /** 新候补订单入队：O(log W) 定位 + 插入，保持 createdAt 升序 */
  private enqueueOrder(q: QueueFile, order: Order): QueueEntry {
    const queue = this.getQueue(q, order.trainCode);
    const entry: QueueEntry = {
      id: order.id,
      fromIdx: order.fromIdx,
      toIdx: order.toIdx,
      createdAt: order.createdAt
    };
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((queue[mid] as QueueEntry).createdAt < entry.createdAt) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, entry);
    return entry;
  }

  /** 按订单从队列移除（出票/取消，幂等） */
  private dequeueOrder(q: QueueFile, order: Order): void {
    const queue = q.trains[order.trainCode];
    if (!queue) return;
    const idx = queue.findIndex((e) => e.id === order.id);
    if (idx !== -1) queue.splice(idx, 1);
  }

  /* ---------- 查询 ---------- */

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

  /* ---------- 座位分配 ---------- */

  /**
   * 为单张订单寻找座位：
   * 1) 逐个「已占用座位」（升序）检查目标区间是否完全空闲（O(占用座位数 × S)，与座位上限无关）；
   * 2) 全部冲突时分配最小可用新座位号（未占用座位必然全程空闲）。
   */
  private allocateSeatForOrder(train: Train, issuedOrders: readonly Order[], order: Order): number | null {
    const stationCount = train.stationSeq.length;
    const bySeat = groupBySeat(issuedOrders);
    const seatNos = Array.from(bySeat.keys()).sort((a, b) => a - b);
    for (const seatNo of seatNos) {
      const load = seatLoad(bySeat.get(seatNo) ?? [], stationCount);
      let free = true;
      for (let i = order.fromIdx; i < order.toIdx; i++) {
        if ((load[i] ?? 0) > 0) {
          free = false;
          break;
        }
      }
      if (free) return seatNo;
    }
    // 新座位：未占用座位全程空闲，取最小可用编号
    let s = 1;
    while (bySeat.has(s)) s++;
    return s <= train.seatCount ? s : null;
  }

  /** 车次剩余运力摘要（未占用座位以计数表示，不逐一座位枚举） */
  capacitySummary(train: Train, orders: readonly Order[]): CapacitySummary {
    const stationCount = train.stationSeq.length;
    const totalSegments = Math.max(stationCount - 1, 0);
    const issued = orders.filter((o) => o.status === OrderStatus.ISSUED);
    const bySeat = groupBySeat(issued);

    let freeSegments = 0;
    const perSeat: SeatFreeStat[] = [];
    Array.from(bySeat.keys())
      .sort((a, b) => a - b)
      .forEach((seatNo) => {
        const load = seatLoad(bySeat.get(seatNo) ?? [], stationCount);
        const free = load.filter((x) => x === 0).length;
        perSeat.push({ seatNo, freeSegments: free });
        freeSegments += free;
      });

    const emptySeatCount = Math.max(train.seatCount - perSeat.length, 0);
    freeSegments += emptySeatCount * totalSegments;

    return { totalSegments, freeSegments, perSeat, emptySeatCount };
  }

  /** 车次容量 + 出票/候补计数汇总（购票页提示用） */
  capacityOverview(train: Train, orders: readonly Order[]): CapacitySummaryResult {
    return {
      summary: this.capacitySummary(train, orders),
      issuedCount: orders.filter((o) => o.status === OrderStatus.ISSUED).length,
      waitingCount: orders.filter((o) => o.status === OrderStatus.WAITING).length
    };
  }

  /* ---------- 补录扫描（单 train，逐单区间适配） ---------- */

  /**
   * 按队列时戳升序逐单尝试区间适配：出票即出队并继续尝试后续订单
   * （最大化利用率）；无适配座位则留队。悬空条目（订单已删/已出票）出队。
   */
  processTrainWaiting(train: Train): ProcessResult {
    const orders = this.currentOrders();
    const orderById = new Map<string, Order>();
    orders.forEach((o) => orderById.set(o.id, o));
    const issued = orders.filter(
      (o) => o.trainCode === train.code && o.status === OrderStatus.ISSUED
    );

    const q = this.currentQueues();
    const queue = this.getQueue(q, train.code);

    const result: Order[] = [];
    let changed = false;
    const kept: QueueEntry[] = [];
    queue.forEach((entry) => {
      const o = entry.id !== undefined ? orderById.get(entry.id) : undefined;
      if (!o || o.status !== OrderStatus.WAITING) {
        changed = true; // 悬空条目（订单已删/已出票/已取消）：出队
        return;
      }
      const seatNo = this.allocateSeatForOrder(train, issued, o);
      if (seatNo === null) {
        kept.push(entry); // 区间无可放座位：留在队列
        return;
      }
      o.issue(seatNo);
      issued.push(o);
      result.push(o);
      changed = true;
      this.pushEvent(
        EventType.Fulfilled,
        '候补补录：' + o.fromIdx + '→' + o.toIdx + ' 分配座位 ' + seatNo,
        train.code,
        o.id
      );
    });
    q.trains[train.code] = kept;

    if (changed) {
      this.saveOrders(orders);
      this.saveQueues(q);
    }
    return { issued: result, changed };
  }

  /** 遍历全部有候补的车次执行补录扫描，返回兑现总单数 */
  processAllWaiting(): number {
    const q = this.currentQueues();
    let fulfilled = 0;
    this.trainService.list().forEach((t) => {
      const queue = q.trains[t.code];
      if (queue && queue.length) {
        fulfilled += this.processTrainWaiting(t).issued.length;
      }
    });
    return fulfilled;
  }

  /* ---------- 购票 / 退票 ---------- */

  /**
   * 购票：创建订单 → O(log W) 入队 → 立即对该车次做一次补录扫描。
   * createdAt 叠加微小确定性偏移，保证同毫秒提交的排序稳定（教训 #6）。
   */
  purchase(trainCode: string, fromIdx: number, toIdx: number): PurchaseResult {
    const train = this.trainService.get(trainCode);
    if (!train) return { ok: false, msg: '车次不存在' };
    if (!(fromIdx >= 0 && toIdx > fromIdx)) return { ok: false, msg: '非法区间' };
    if (toIdx >= train.stationSeq.length) return { ok: false, msg: '区间超出车次站序' };

    const orders = this.currentOrders();
    const newOrder = Order.fromDto({
      id: uid('o'),
      trainCode,
      fromIdx,
      toIdx,
      status: OrderStatus.WAITING,
      createdAt: Date.now() + (orders.length % 1000) * 0.001
    });
    orders.push(newOrder);
    this.saveOrders(orders);

    // 在线入队 + 补录扫描
    const q = this.currentQueues();
    this.enqueueOrder(q, newOrder);
    this.saveQueues(q);
    this.pushEvent(EventType.Purchase, '购票请求：' + trainCode + ' ' + fromIdx + '→' + toIdx, trainCode, newOrder.id);

    this.processTrainWaiting(train);
    const final = this.currentOrders().find((o) => o.id === newOrder.id) ?? null;

    if (final && final.status === OrderStatus.ISSUED) {
      const seatNo = final.seatNo ?? 0;
      this.pushEvent(EventType.Issued, '出票成功：座位 ' + seatNo, trainCode, newOrder.id);
      return { ok: true, issued: true, seatNo, order: final };
    }

    const rank =
      this.waitingOrdersOfTrain(trainCode).findIndex((o) => o.id === newOrder.id) + 1;
    this.pushEvent(EventType.Waitlisted, '进入候补（第 ' + rank + ' 位）', trainCode, newOrder.id);
    return { ok: true, issued: false, position: rank, order: final };
  }

  /**
   * 退票 / 取消候补（新语义：状态置 CANCELLED，保留订单历史）：
   * - issued：释放座位区间（占用统计随即排除该单），随后自动按时间戳补录；
   * - waiting：取消候补，出队。
   * 幂等：已 CANCELLED 的订单拒绝重复操作。
   */
  refundOrder(orderId: string): RefundResult {
    const orders = this.currentOrders();
    const order = orders.find((o) => o.id === orderId);
    if (!order) return { ok: false, msg: '订单不存在' };
    if (order.status === OrderStatus.CANCELLED) return { ok: false, msg: '该订单已退票/取消，无需重复操作' };

    const wasIssued = order.status === OrderStatus.ISSUED;
    const q = this.currentQueues();
    this.dequeueOrder(q, order);
    this.saveQueues(q);

    order.cancel();
    this.saveOrders(orders);
    this.pushEvent(
      EventType.Refund,
      wasIssued ? '退票：座位 ' + order.seatNo + ' 释放（订单保留为已取消）' : '取消候补',
      order.trainCode,
      orderId
    );

    // 释放区间后立即按时间戳补录
    const train = this.trainService.get(order.trainCode);
    let fulfilled = 0;
    if (train) {
      fulfilled = this.processTrainWaiting(train).issued.length;
    }
    return { ok: true, fulfilled };
  }
}
