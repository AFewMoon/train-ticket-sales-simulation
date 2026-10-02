/* 引擎传输层：Worker 计算路径的主线程侧适配器——
   从仓库构建快照（postMessage 结构化克隆的输入）、把引擎补丁落盘回仓库。
   仅在 Worker 路径使用（主线程直算路径走 TicketingService 内部的事务感知包装）。 */

import type { OrderDto } from '../domain/model/order';
import type { Train } from '../domain/model/train';
import type { DomainEvent } from '../domain/model/event';
import type { IRepository } from '../domain/repository';
import { Order } from '../domain/model/order';
import type { QueueFile } from '../infrastructure/persistence-shapes';
import {
  applyPatchToStore,
  type EnginePatch,
  type FullScopeSnapshot,
  type TrainScopeSnapshot
} from '../domain/engine/protocol';
import { EVENTS_CAP } from '../domain/engine/ticketing-engine';
import type { NumberingService } from '../domain/services/numbering-service';

export class EngineTransport {
  constructor(
    private readonly trainRepo: IRepository<Train[]>,
    private readonly orderDtoRepo: IRepository<OrderDto[]>,
    private readonly queueRepo: IRepository<QueueFile>,
    private readonly eventRepo: IRepository<DomainEvent[]>,
    private readonly numbering: NumberingService
  ) {}

  /** 号码池快照（车次号唯一性检查用，已删除车次的号码不复用） */
  seqTrainCodes(): string[] {
    return this.numbering.getSeqPools().trainCodes;
  }

  /** 引擎新建车次落盘 + 号码池登记（仿真结果的车次不在订单/队列补丁机制内） */
  registerTrains(trains: Train[]): void {
    if (!trains.length) return;
    const all = this.trainRepo.read();
    all.push(...trains);
    this.trainRepo.write(all);
    trains.forEach((t) => this.numbering.registerTrainCode(t.code));
  }

  /** 单车次快照：该车次订单 + 队列（订单不存在时 train 为 null，由引擎返回失败） */
  buildTrainScope(trainCode: string): TrainScopeSnapshot {
    const orders = this.orderDtoRepo.read().filter((o) => o.trainCode === trainCode);
    const queue = this.queueRepo.read().trains[trainCode] ?? [];
    return { train: this.trainRepo.read().find((t) => t.code === trainCode) ?? null, orders, queue };
  }

  /** 全量快照：批量运算（退票模拟/对账/仿真）使用 */
  buildFullScope(): FullScopeSnapshot {
    const qf = this.queueRepo.read();
    const queues: FullScopeSnapshot['queues'] =
      qf.trains && typeof qf.trains === 'object' && !Array.isArray(qf.trains) ? qf.trains : {};
    return { trains: this.trainRepo.read(), orders: this.orderDtoRepo.read(), queues };
  }

  /** 补丁落盘：订单按 id upsert、队列按策略合并、事件追加并维持上限 */
  applyPatch(patch: EnginePatch): void {
    applyPatchToStore(
      {
        getOrders: () => this.orderDtoRepo.read().map(Order.fromDto),
        saveOrders: (orders) => {
          this.orderDtoRepo.write(orders.map((o) => o.toDto()));
        },
        getQueues: () => this.queueRepo.read(),
        saveQueues: (q) => {
          this.queueRepo.write(q);
        },
        getEvents: () => this.eventRepo.read(),
        saveEvents: (events) => {
          this.eventRepo.write(events);
        }
      },
      patch,
      EVENTS_CAP
    );
  }

  /** 供网关判断订单归属（退票需要先定位 trainCode 构建单车次快照） */
  findOrderDto(orderId: string): OrderDto | null {
    return this.orderDtoRepo.read().find((o) => o.id === orderId) ?? null;
  }
}
