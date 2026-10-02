/* 引擎协议：主线程与计算引擎（Worker 或主线程直算回退）之间的全部数据契约。
   - 快照（Snapshot）：纯 DTO 数据，可结构化克隆跨 postMessage 传输；
   - 补丁（Patch）：引擎运算后的变更集，由主线程经仓库落盘；
   - 消息（Request/Response）：Worker RPC 封包，主线程直算路径复用同一 Outcome 形状，
     保证两条路径行为等价、可被同一套测试覆盖。 */

import { Order, type OrderDto } from '../model/order';
import type { DomainEvent } from '../model/event';
import type { Train } from '../model/train';
import type { Line } from '../model/line';
import type { QueueEntry } from '../../infrastructure/persistence-shapes';

/* ---------- 出票结果类型（自 ticketing-service 迁入，服务层 re-export 兼容） ---------- */

export type PurchaseResult =
  | { ok: false; msg: string }
  | { ok: true; issued: true; seatNo: number; order: OrderDto }
  | { ok: true; issued: false; position: number; order: OrderDto | null };

export type RefundResult = { ok: false; msg: string } | { ok: true; fulfilled: number };

/** 退票模拟结果（原 UI 层业务下沉后的形态） */
export type RefundSimResult = { ok: false; msg: string } | { ok: true; refunded: number; fulfilled: number };

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

// ProcessResult 引用 Order 实体（仅类型层使用）
/* ---------- 快照 ---------- */

/** 单车次快照：单次购票/退票只传该车次数据，降低结构化克隆拷贝量 */
export interface TrainScopeSnapshot {
  train: Train | null;
  /** 该车次全部订单（全状态） */
  orders: OrderDto[];
  /** 该车次候补队列 */
  queue: QueueEntry[];
}

/** 全量快照：批量运算（退票模拟/对账/仿真）一次传输 */
export interface FullScopeSnapshot {
  trains: Train[];
  orders: OrderDto[];
  queues: Record<string, QueueEntry[]>;
}

/* ---------- 补丁 ---------- */

/** 队列合并策略：
 *  - replace-codes：按 code 整段替换（购票/退票——引擎返回该车次全量队列）
 *  - replace-all：整个 trains 记录替换（对账——引擎是队列的唯一裁决者）
 *  - merge-append：条目为新增，按 createdAt 归并排序（仿真——引擎只产生新候补） */
export type QueuePatchStrategy = 'replace-codes' | 'replace-all' | 'merge-append';

export interface EnginePatch {
  /** 订单按 id upsert（不删除——CANCELLED 语义下订单只增改） */
  orders: OrderDto[];
  queueStrategy: QueuePatchStrategy;
  queues: Record<string, QueueEntry[]>;
  /** 新增领域事件（主线程追加并维持 500 上限） */
  events: DomainEvent[];
}

export interface TicketingOutcome<R> {
  result: R;
  patch: EnginePatch;
}

/** 补丁落盘适配器：服务层（事务感知）与传输层（仓库直写）各自实现 */
export interface PatchStore {
  getOrders(): Order[];
  saveOrders(orders: Order[]): void;
  getQueues(): { trains: Record<string, QueueEntry[]> };
  saveQueues(queues: { trains: Record<string, QueueEntry[]> }): void;
  getEvents(): DomainEvent[];
  saveEvents(events: DomainEvent[]): void;
}

/** 补丁统一落盘：订单按 id 归并、队列按策略合并、事件追加并维持上限 */
export function applyPatchToStore(store: PatchStore, patch: EnginePatch, eventsCap: number): void {
  if (patch.orders.length) {
    const orders = store.getOrders();
    const patchById = new Map(patch.orders.map((dto) => [dto.id, dto]));
    for (let i = 0; i < orders.length; i++) {
      const dto = patchById.get(orders[i]?.id ?? '');
      if (dto) orders[i] = Order.fromDto(dto);
    }
    const existingIds = new Set(orders.map((o) => o.id));
    patch.orders.forEach((dto) => {
      if (!existingIds.has(dto.id)) orders.push(Order.fromDto(dto));
    });
    store.saveOrders(orders);
  }

  if (patch.queueStrategy === 'replace-all') {
    // 整体重建文件对象：丢弃旧结构残留键（如 legacy buckets，教训 #16）
    store.saveQueues({
      trains: JSON.parse(JSON.stringify(patch.queues)) as Record<string, QueueEntry[]>
    });
  } else {
    const q = store.getQueues();
    if (patch.queueStrategy === 'replace-codes') {
      Object.entries(patch.queues).forEach(([code, entries]) => {
        q.trains[code] = entries;
      });
    } else {
      Object.entries(patch.queues).forEach(([code, entries]) => {
        let list = q.trains[code];
        if (!list) {
          list = [];
          q.trains[code] = list;
        }
        list.push(...entries);
        list.sort((a, b) => a.createdAt - b.createdAt);
      });
    }
    store.saveQueues(q);
  }

  if (patch.events.length) {
    let events = store.getEvents();
    events.push(...patch.events);
    if (events.length > eventsCap) events = events.slice(events.length - eventsCap);
    store.saveEvents(events);
  }
}

/* ---------- 仿真 ---------- */

export interface SimulationConfig {
  /** 仿真线路 ID；'__auto__' 表示自动生成一条模拟线路（主线程 prepare 解析） */
  lineId: string;
  autoStationCount: number;
  countDirect: number;
  countExpress: number;
  countSkip: number;
  seats: number;
  requests: number;
  /** 负数表示随机种子；其余值结果可复现 */
  seed: number;
}

export const AUTO_LINE_ID = '__auto__';

export interface SimRequestEvent {
  trainCode: string;
  fromIdx: number;
  toIdx: number;
  issued: boolean;
  seatNo?: number;
  position?: number;
}

export interface PerTrainStat {
  train: Train;
  requests: number;
  issued: number;
  waiting: number;
}

/** 引擎返回的仿真统计（不含 line 引用——由主线程组装 SimulationSummary） */
export interface SimulationSummaryData {
  perTrain: Record<string, PerTrainStat>;
  events: SimRequestEvent[];
  totalRequests: number;
  totalIssued: number;
  totalWaiting: number;
  issuedRate: number;
  usedSeed: number;
  elapsedMs: number;
}

export type SimulationEngineResult =
  | { ok: false; msg: string }
  | { ok: true; trains: Train[]; summaryData: SimulationSummaryData };

/* ---------- Worker 消息 ---------- */

export interface EngineResultMap {
  purchase: PurchaseResult;
  refund: RefundResult;
  refundSimulation: RefundSimResult;
  reconcile: { fulfilled: number };
  simulate: SimulationEngineResult;
}

export type EngineRequest =
  | { id: number; kind: 'purchase'; scope: TrainScopeSnapshot; trainCode: string; fromIdx: number; toIdx: number; now: number }
  | { id: number; kind: 'refund'; scope: TrainScopeSnapshot; orderId: string; now: number }
  | { id: number; kind: 'refundSimulation'; scope: FullScopeSnapshot; rate: number; now: number }
  | { id: number; kind: 'reconcile'; scope: FullScopeSnapshot; now: number }
  | { id: number; kind: 'simulate'; scope: FullScopeSnapshot; line: Line; cfg: SimulationConfig; seqTrainCodes: string[]; now: number };

export type EngineResponse =
  | { id: number; ok: false; msg: string }
  | {
      [K in keyof EngineResultMap]: {
        id: number;
        ok: true;
        kind: K;
        result: EngineResultMap[K];
        patch: EnginePatch;
      };
    }[keyof EngineResultMap];
