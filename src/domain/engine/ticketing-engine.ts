/* 出票纯函数引擎（逐单区间适配 · 在线版）：
   自 TicketingService 提取的算法核心——快照进（纯 DTO）、补丁出（变更集），
   无仓库/DOM 依赖，可运行于 Web Worker 或主线程（回退路径），两者共用同一实现。
   规则要点（教训见 AGENTS.md）：
   - 候补按 createdAt 升序逐单适配，任一座位区间完全空闲即出票（允许空洞）；
   - 占用统计只遍历「已占用座位集合」（#20，支持 INT_MAX 座位）；
   - createdAt 含同毫秒稳定排序小数偏移（#6）；
   - 退票/取消置 CANCELLED 保留历史，占用统计只认 ISSUED。 */

import { uid } from '../model/primitives';
import { Order, OrderStatus } from '../model/order';
import type { Train } from '../model/train';
import { EventType, type DomainEvent } from '../model/event';
import type { QueueEntry } from '../../infrastructure/persistence-shapes';
import type {
  CapacitySummary,
  EnginePatch,
  FullScopeSnapshot,
  PurchaseResult,
  RefundResult,
  RefundSimResult,
  SeatFreeStat,
  TicketingOutcome,
  TrainScopeSnapshot
} from './protocol';

/** 事件上限（与 tts:events 持久化约束一致） */
export const EVENTS_CAP = 500;

/* ---------- 事件 ---------- */

function makeEvent(type: EventType, detail: string, trainCode: string, orderId: string, now: number): DomainEvent {
  return { id: uid('e'), ts: now, type, trainCode, orderId, detail };
}

/* ---------- 座位占用（纯计算） ---------- */

/** 将已出票订单按座位分组：只含有票座位——未占用座位不占内存与计算量 */
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

/** 车次剩余运力摘要（未占用座位以计数表示，不逐一座位枚举） */
export function capacitySummary(train: Train, orders: readonly Order[]): CapacitySummary {
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

/**
 * 为单张订单寻找座位：
 * 1) 逐个「已占用座位」（升序）检查目标区间是否完全空闲（O(占用座位数 × S)，与座位上限无关）；
 * 2) 全部冲突时分配最小可用新座位号（未占用座位必然全程空闲）。
 */
export function allocateSeatForOrder(train: Train, issuedOrders: readonly Order[], order: Order): number | null {
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
  let s = 1;
  while (bySeat.has(s)) s++;
  return s <= train.seatCount ? s : null;
}

/* ---------- 内存态候补队列 ---------- */

function enqueue(queue: QueueEntry[], order: Order): QueueEntry {
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

function dequeue(queue: QueueEntry[] | undefined, orderId: string): void {
  if (!queue) return;
  const idx = queue.findIndex((e) => e.id === orderId);
  if (idx !== -1) queue.splice(idx, 1);
}

interface WaitingOutcome {
  issued: Order[];
  changed: boolean;
}

/** 补录扫描（内存态）：按队列时戳升序逐单区间适配，出票即出队并继续；悬空条目出队 */
function processWaitingInMemory(
  train: Train,
  orders: Order[],
  queue: QueueEntry[],
  events: DomainEvent[],
  now: number
): WaitingOutcome {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const issued = orders.filter((o) => o.trainCode === train.code && o.status === OrderStatus.ISSUED);

  const result: Order[] = [];
  let changed = false;
  const kept: QueueEntry[] = [];
  queue.forEach((entry) => {
    const o = entry.id !== undefined ? orderById.get(entry.id) : undefined;
    if (!o || o.status !== OrderStatus.WAITING) {
      changed = true; // 悬空条目（订单已删/已出票/已取消）：出队
      return;
    }
    const seatNo = allocateSeatForOrder(train, issued, o);
    if (seatNo === null) {
      kept.push(entry); // 区间无可放座位：留在队列
      return;
    }
    o.issue(seatNo);
    issued.push(o);
    result.push(o);
    changed = true;
    events.push(
      makeEvent(EventType.Fulfilled, '候补补录：' + o.fromIdx + '→' + o.toIdx + ' 分配座位 ' + seatNo, train.code, o.id, now)
    );
  });
  queue.length = 0;
  queue.push(...kept);
  return { issued: result, changed };
}

/* ---------- 购票 ---------- */

export function applyPurchase(
  scope: TrainScopeSnapshot,
  trainCode: string,
  fromIdx: number,
  toIdx: number,
  now: number
): TicketingOutcome<PurchaseResult> {
  const fail = (msg: string): TicketingOutcome<PurchaseResult> => ({
    result: { ok: false, msg },
    patch: { orders: [], queueStrategy: 'replace-codes', queues: {}, events: [] }
  });
  const train = scope.train;
  if (!train) return fail('车次不存在');
  if (!(fromIdx >= 0 && toIdx > fromIdx)) return fail('非法区间');
  if (toIdx >= train.stationSeq.length) return fail('区间超出车次站序');

  const orders = scope.orders.map(Order.fromDto);
  const newOrder = new Order({
    id: uid('o'),
    trainCode,
    fromIdx,
    toIdx,
    status: OrderStatus.WAITING,
    createdAt: now + (orders.length % 1000) * 0.001 // 同毫秒排序稳定（教训 #6）
  });
  orders.push(newOrder);

  const events: DomainEvent[] = [
    makeEvent(EventType.Purchase, '购票请求：' + trainCode + ' ' + fromIdx + '→' + toIdx, trainCode, newOrder.id, now)
  ];

  // 在线入队 + 补录扫描
  const queue = scope.queue.map((e) => ({ ...e }));
  enqueue(queue, newOrder);
  processWaitingInMemory(train, orders, queue, events, now);

  const final = orders.find((o) => o.id === newOrder.id) ?? null;
  let result: PurchaseResult;
  if (final && final.status === OrderStatus.ISSUED) {
    const seatNo = final.seatNo ?? 0;
    events.push(makeEvent(EventType.Issued, '出票成功：座位 ' + seatNo, trainCode, newOrder.id, now));
    result = { ok: true, issued: true, seatNo, order: final.toDto() };
  } else {
    const rank =
      orders
        .filter((o) => o.trainCode === trainCode && o.status === OrderStatus.WAITING)
        .sort((a, b) => a.createdAt - b.createdAt)
        .findIndex((o) => o.id === newOrder.id) + 1;
    events.push(makeEvent(EventType.Waitlisted, '进入候补（第 ' + rank + ' 位）', trainCode, newOrder.id, now));
    result = { ok: true, issued: false, position: rank, order: final ? final.toDto() : null };
  }

  return {
    result,
    patch: { orders: orders.map((o) => o.toDto()), queueStrategy: 'replace-codes', queues: { [trainCode]: queue }, events }
  };
}

/* ---------- 退票 / 取消候补（CANCELLED 语义） ---------- */

export function applyRefund(
  scope: TrainScopeSnapshot,
  orderId: string,
  now: number
): TicketingOutcome<RefundResult> {
  const orders = scope.orders.map(Order.fromDto);
  const order = orders.find((o) => o.id === orderId);
  const fail = (msg: string): TicketingOutcome<RefundResult> => ({
    result: { ok: false, msg },
    patch: { orders: [], queueStrategy: 'replace-codes', queues: {}, events: [] }
  });
  if (!order) return fail('订单不存在');
  if (order.status === OrderStatus.CANCELLED) return fail('该订单已退票/取消，无需重复操作');

  const wasIssued = order.status === OrderStatus.ISSUED;
  const queue = scope.queue.map((e) => ({ ...e }));
  dequeue(queue, orderId);

  order.cancel();
  const events: DomainEvent[] = [
    makeEvent(
      EventType.Refund,
      wasIssued ? '退票：座位 ' + order.seatNo + ' 释放（订单保留为已取消）' : '取消候补',
      order.trainCode,
      orderId,
      now
    )
  ];

  // 释放区间后立即按时间戳补录
  let fulfilled = 0;
  if (scope.train) {
    fulfilled = processWaitingInMemory(scope.train, orders, queue, events, now).issued.length;
  }

  return {
    result: { ok: true, fulfilled },
    patch: {
      orders: orders.map((o) => o.toDto()),
      queueStrategy: 'replace-codes',
      queues: { [order.trainCode]: queue },
      events
    }
  };
}

/* ---------- 退票模拟（批量） ---------- */

export function applyRefundSimulation(
  scope: FullScopeSnapshot,
  rate: number,
  now: number
): TicketingOutcome<RefundSimResult> {
  const failPatch = (): EnginePatch => ({ orders: [], queueStrategy: 'replace-all', queues: {}, events: [] });
  if (!isFinite(rate) || rate < 1 || rate > 100) {
    return { result: { ok: false, msg: '退票比率需在 1-100 之间' }, patch: failPatch() };
  }
  const orders = scope.orders.map(Order.fromDto);
  const trainByCode = new Map(scope.trains.map((t) => [t.code, t]));
  const queues: Record<string, QueueEntry[]> = {};
  Object.entries(scope.queues).forEach(([code, entries]) => {
    queues[code] = (entries ?? []).map((e) => ({ ...e }));
  });

  const issued = orders.filter((o) => o.status === OrderStatus.ISSUED);
  const count = Math.max(1, Math.round((issued.length * rate) / 100));
  // Fisher-Yates 随机抽取不重复的订单逐张退票
  for (let i = issued.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = issued[i];
    const b = issued[j];
    if (a === undefined || b === undefined) continue;
    issued[i] = b;
    issued[j] = a;
  }

  const events: DomainEvent[] = [];
  let refunded = 0;
  let fulfilled = 0;
  for (let k = 0; k < count && k < issued.length; k++) {
    const order = issued[k];
    if (!order || order.status !== OrderStatus.ISSUED) continue;
    const train = trainByCode.get(order.trainCode) ?? null;
    let queue = queues[order.trainCode];
    if (!queue) {
      queue = [];
      queues[order.trainCode] = queue;
    }
    dequeue(queue, order.id);
    order.cancel();
    events.push(
      makeEvent(EventType.Refund, '退票：座位 ' + order.seatNo + ' 释放（订单保留为已取消）', order.trainCode, order.id, now)
    );
    refunded++;
    if (train) {
      fulfilled += processWaitingInMemory(train, orders, queue, events, now).issued.length;
    }
  }

  return {
    result: { ok: true, refunded, fulfilled },
    patch: { orders: orders.map((o) => o.toDto()), queueStrategy: 'replace-all', queues, events }
  };
}

/* ---------- 启动对账 ---------- */

/**
 * 队列与订单对账（幂等，教训 #16/#13）：
 * - 文件级形状归一：非数组条目或含 buckets 的旧结构条目按 code 废弃；
 * - 不存在车次且无候补的队列：废弃；
 * - 悬空条目出队、缺失候补按 createdAt 二分补插；
 * - 随后对每个有候补的车次做一次补录扫描。
 */
export function applyReconcile(
  scope: FullScopeSnapshot,
  now: number
): TicketingOutcome<{ fulfilled: number }> {
  const orders = scope.orders.map(Order.fromDto);
  const trainByCode = new Map(scope.trains.map((t) => [t.code, t]));
  const queues: Record<string, QueueEntry[]> = {};
  Object.entries(scope.queues).forEach(([code, entries]) => {
    if (Array.isArray(entries)) queues[code] = entries.map((e) => ({ ...e }));
  });

  const waitingByTrain = new Map<string, Order[]>();
  const waitingIds = new Set<string>();
  orders.forEach((o) => {
    if (o.status !== OrderStatus.WAITING) return;
    const list = waitingByTrain.get(o.trainCode);
    if (list) list.push(o);
    else waitingByTrain.set(o.trainCode, [o]);
    waitingIds.add(o.id);
  });

  // 旧结构/无主队列废弃
  Object.keys(queues).forEach((code) => {
    const queue = queues[code];
    const legacy = queue !== null && typeof queue === 'object' && !Array.isArray(queue) && 'buckets' in queue;
    if (!Array.isArray(queue) || legacy || (!trainByCode.has(code) && !waitingByTrain.has(code))) {
      delete queues[code];
    }
  });

  // 悬空条目出队
  Object.keys(queues).forEach((code) => {
    const queue = queues[code] as QueueEntry[];
    for (let i = queue.length - 1; i >= 0; i--) {
      const entry = queue[i];
      if (!entry || !waitingIds.has(entry.id)) queue.splice(i, 1);
    }
  });

  // 缺失候补按 createdAt 二分补插
  waitingByTrain.forEach((list, code) => {
    if (!trainByCode.has(code)) return;
    let queue = queues[code];
    if (!queue) {
      queue = [];
      queues[code] = queue;
    }
    list.forEach((o) => {
      const exists = queue?.some((e) => e.id === o.id);
      if (!exists) {
        const entry: QueueEntry = { id: o.id, fromIdx: o.fromIdx, toIdx: o.toIdx, createdAt: o.createdAt };
        let lo = 0;
        let hi = queue?.length ?? 0;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((queue?.[mid] as QueueEntry).createdAt < entry.createdAt) lo = mid + 1;
          else hi = mid;
        }
        queue?.splice(lo, 0, entry);
      }
    });
  });

  // 对每个有候补的车次做补录扫描
  const events: DomainEvent[] = [];
  let fulfilled = 0;
  Object.keys(queues).forEach((code) => {
    const queue = queues[code] as QueueEntry[];
    if (!queue.length) return;
    const train = trainByCode.get(code);
    if (!train) return;
    fulfilled += processWaitingInMemory(train, orders, queue, events, now).issued.length;
  });

  return {
    result: { fulfilled },
    patch: { orders: orders.map((o) => o.toDto()), queueStrategy: 'replace-all', queues, events }
  };
}
