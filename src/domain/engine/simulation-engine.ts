/* 仿真纯函数引擎：三类车次生成（直达车/大站快车/隔站停车）+ 批量购票全流程，
   全内存运算、快照进/补丁出；可运行于 Web Worker 或主线程（回退路径）。
   教训 #8：sim 标记在创建路径收口处统一打上（订单在创建时即 sim: true）。
   保真度说明：车次号生成用 Math.random（与原 allocateTrainCode 一致，不参与同种子复现）；
   补录可能兑现快照中既有的候补订单，其状态变更纳入补丁（按 id upsert）。 */

import { uid } from '../model/primitives';
import { Order, OrderStatus } from '../model/order';
import type { Line } from '../model/line';
import { isSubsequence } from '../model/line';
import type { Train } from '../model/train';
import { CODE_FIRST_DIGITS, CODE_LAST_DIGITS, SimType } from '../model/train';
import { EventType, type DomainEvent } from '../model/event';
import type { QueueEntry } from '../../infrastructure/persistence-shapes';
import type {
  FullScopeSnapshot,
  PerTrainStat,
  SimulationConfig,
  SimulationEngineResult,
  SimRequestEvent,
  TicketingOutcome
} from './protocol';
import { allocateSeatForOrder } from './ticketing-engine';

/* ---------- 可复现随机数（mulberry32） ---------- */

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = (Number(seed) || 0) >>> 0;
  if (!a) a = 0x9e3779b9;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: Rng, min: number, max: number): number {
  // [min, max]
  return min + Math.floor(rng() * (max - min + 1));
}

/* ---------- 三类车次生成规则 ---------- */

/** 各类型车次字头：直达车与大站快车 G、隔站停车 D */
export const TYPE_PREFIX: Record<SimType, 'G' | 'D'> = {
  [SimType.Direct]: 'G',
  [SimType.Express]: 'G',
  [SimType.Skip]: 'D'
};

export interface SimTypeMeta {
  label: string;
  badge: string;
}

export const TYPE_META: Record<SimType, SimTypeMeta> = {
  [SimType.Direct]: { label: '直达车', badge: 'badge-type-direct' },
  [SimType.Express]: { label: '大站快车', badge: 'badge-type-express' },
  [SimType.Skip]: { label: '隔站停车', badge: 'badge-type-skip' }
};

/** 各类型车次最小停站数（含起终点）：直达 2、大站快车中途 ≥1、隔站停车中途 ≥3 */
export const TYPE_MIN_STOPS: Record<SimType, number> = {
  [SimType.Direct]: 2,
  [SimType.Express]: 3,
  [SimType.Skip]: 5
};

/** 车次的仿真类型（未标记返回 null） */
export function typeOfTrain(train: Train): SimType | null {
  return train.simType ?? null;
}

function pickStops(rng: Rng, line: Line, type: SimType): string[] | null {
  const seq = line.stationSeq;
  const majors = line.majorNos ?? [];
  const n = seq.length;
  let stops: string[] | null = null;
  if (type === SimType.Direct) {
    // 两点直达：仅在大站之间开行（两端均为大站），中间不停靠
    if (majors.length < 2) return null;
    const mi = randInt(rng, 0, majors.length - 2);
    const mj = randInt(rng, mi + 1, majors.length - 1);
    stops = [majors[mi] ?? '', majors[mj] ?? ''];
  } else if (type === SimType.Express) {
    // 大站快车：随机取两个大站作为始发/终到（不一定线路首末），只停靠区间内大站；
    // 起终点之间至少停靠 1 站——由选取约束保证（mj2 ≥ mi2 + 2）
    if (majors.length < 3) return null;
    const mi2 = randInt(rng, 0, majors.length - 3);
    const mj2 = randInt(rng, mi2 + 2, majors.length - 1);
    stops = majors.slice(mi2, mj2 + 1);
  } else if (type === SimType.Skip) {
    // 隔站停车：随机起终点（不限线路首末），以隔 1~3 站推进，
    // 途经大站必停（大站优先于随机间隔），终点必停；
    // 起终点之间至少停靠 3 站（stops.length ≥ 5），不满足则重试，线路过短无法满足时返回 null
    for (let attempt = 0; attempt < 8; attempt++) {
      const start = randInt(rng, 0, n - 2);
      // 优先保证足够长的运行区段，减少因随机到短区段而浪费的重试
      const lo = Math.min(start + 6, n - 1);
      const end = randInt(rng, lo, n - 1);
      let cur = start;
      const candidate: string[] = [seq[cur] ?? ''];
      while (cur < end) {
        const gapNext = cur + 1 + randInt(rng, 1, 3);
        let nextMajor = -1;
        for (let m = cur + 1; m < end; m++) {
          if (majors.indexOf(seq[m] ?? '') !== -1) {
            nextMajor = m;
            break;
          }
        }
        let next = Math.min(gapNext, end);
        if (nextMajor !== -1 && nextMajor < next) next = nextMajor;
        candidate.push(seq[next] ?? '');
        cur = next;
      }
      if (candidate.length >= 5) {
        stops = candidate;
        break;
      }
    }
  }
  return stops;
}

/** 随机车次号 4 位部分：首位 1~3/6~8、末位奇数（Math.random，与原 allocateTrainCode 一致） */
function randomCodeDigits(): string {
  const rand = (): number => Math.random();
  const first = CODE_FIRST_DIGITS[Math.floor(rand() * CODE_FIRST_DIGITS.length)] ?? '1';
  const mid1 = Math.floor(rand() * 10);
  const mid2 = Math.floor(rand() * 10);
  const last = CODE_LAST_DIGITS[Math.floor(rand() * CODE_LAST_DIGITS.length)] ?? '1';
  return first + mid1 + mid2 + last;
}

/* ---------- 内存态购票 ---------- */

interface MemoryScope {
  orders: Order[];
  queues: Record<string, QueueEntry[]>;
  events: DomainEvent[];
  now: number;
}

function getQueue(scope: MemoryScope, trainCode: string): QueueEntry[] {
  let queue = scope.queues[trainCode];
  if (!queue) {
    queue = [];
    scope.queues[trainCode] = queue;
  }
  return queue;
}

function enqueue(queue: QueueEntry[], order: Order): void {
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
}

function makeEvent(type: EventType, detail: string, trainCode: string, orderId: string, now: number): DomainEvent {
  return { id: uid('e'), ts: now, type, trainCode, orderId, detail };
}

interface PurchaseOutcomeInMemory {
  order: Order;
  issued: boolean;
  seatNo: number | null;
  position: number;
}

/** 内存态购票：创建订单（sim: true，教训 #8）→ 入队 → 补录扫描 → 出票/候补事件 */
function purchaseInMemory(scope: MemoryScope, train: Train, fromIdx: number, toIdx: number): PurchaseOutcomeInMemory {
  const order = new Order({
    id: uid('o'),
    trainCode: train.code,
    fromIdx,
    toIdx,
    status: OrderStatus.WAITING,
    createdAt: scope.now + (scope.orders.length % 1000) * 0.001, // 同毫秒排序稳定（教训 #6）
    sim: true
  });
  scope.orders.push(order);
  const queue = getQueue(scope, train.code);
  enqueue(queue, order);
  scope.events.push(
    makeEvent(EventType.Purchase, '购票请求：' + train.code + ' ' + fromIdx + '→' + toIdx, train.code, order.id, scope.now)
  );

  // 补录扫描（单 train，逐单区间适配）
  const orderById = new Map(scope.orders.map((o) => [o.id, o]));
  const issued = scope.orders.filter((o) => o.trainCode === train.code && o.status === OrderStatus.ISSUED);
  const kept: QueueEntry[] = [];
  queue.forEach((entry) => {
    const o = entry.id !== undefined ? orderById.get(entry.id) : undefined;
    if (!o || o.status !== OrderStatus.WAITING) return;
    const seatNo = allocateSeatForOrder(train, issued, o);
    if (seatNo === null) {
      kept.push(entry);
      return;
    }
    o.issue(seatNo);
    issued.push(o);
    scope.events.push(
      makeEvent(EventType.Fulfilled, '候补补录：' + o.fromIdx + '→' + o.toIdx + ' 分配座位 ' + seatNo, train.code, o.id, scope.now)
    );
  });
  queue.length = 0;
  queue.push(...kept);

  if (order.status === OrderStatus.ISSUED) {
    const seatNo = order.seatNo ?? 0;
    scope.events.push(makeEvent(EventType.Issued, '出票成功：座位 ' + seatNo, train.code, order.id, scope.now));
    return { order, issued: true, seatNo, position: 0 };
  }
  const rank =
    scope.orders
      .filter((o) => o.trainCode === train.code && o.status === OrderStatus.WAITING)
      .sort((a, b) => a.createdAt - b.createdAt)
      .findIndex((o) => o.id === order.id) + 1;
  scope.events.push(makeEvent(EventType.Waitlisted, '进入候补（第 ' + rank + ' 位）', train.code, order.id, scope.now));
  return { order, issued: false, seatNo: null, position: rank };
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/* ---------- 仿真主流程（纯函数） ---------- */

/**
 * 生成车次并批量购票：全内存运算，返回新建车次、订单补丁（含既有候补被兑现的变更）、
 * 受影响车次的全量队列（replace-codes）与新增事件。种子由调用方（prepare）解析为非负值；
 * seqTrainCodes 为号码池快照（已删除车次的号码不复用，与原 allocateTrainCode 一致）。
 */
export function applySimulation(
  scopeSnapshot: FullScopeSnapshot,
  line: Line,
  cfg: SimulationConfig,
  seqTrainCodes: readonly string[],
  now: number
): TicketingOutcome<SimulationEngineResult> {
  const t0 = nowMs();
  const seed = !isFinite(cfg.seed) || cfg.seed < 0 ? Math.floor(Math.random() * 2147483647) : Math.floor(cfg.seed);
  const rng = makeRng(seed);

  // 1. 生成车次（内存态；号码唯一性 = 现存车次 + 号码池快照 + 本批次新建）
  const existingCodes = new Set<string>([
    ...scopeSnapshot.trains.map((t) => t.code),
    ...seqTrainCodes
  ]);
  const newTrains: Train[] = [];
  const plan: Array<[SimType, number]> = [
    [SimType.Direct, cfg.countDirect],
    [SimType.Express, cfg.countExpress],
    [SimType.Skip, cfg.countSkip]
  ];
  const seats = Math.floor(Number(cfg.seats));
  const seatsValid = isFinite(seats) && seats >= 1 && seats <= 2147483647;
  plan.forEach(([type, rawCount]) => {
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    const minStops = TYPE_MIN_STOPS[type];
    for (let i = 0; i < count; i++) {
      const stops = pickStops(rng, line, type);
      if (!stops || stops.length < minStops) continue;
      if (!isSubsequence(stops, line.stationSeq)) continue;
      if (!seatsValid) continue;
      let code: string | null = null;
      for (let attempt = 0; attempt < 5000; attempt++) {
        const candidate = TYPE_PREFIX[type] + randomCodeDigits();
        if (!existingCodes.has(candidate)) {
          code = candidate;
          break;
        }
      }
      if (code === null) continue;
      existingCodes.add(code);
      const train: Train = {
        code,
        stationSeq: stops.slice(),
        seatCount: seats,
        lineId: line.id,
        simType: type,
        sim: true
      };
      newTrains.push(train);
    }
  });

  if (!newTrains.length) {
    return {
      result: { ok: false, msg: '未能生成任何车次，请检查各类车次数参数' },
      patch: { orders: [], queueStrategy: 'replace-codes', queues: {}, events: [] }
    };
  }

  // 2. 批量购票（内存态）
  const memory: MemoryScope = {
    orders: scopeSnapshot.orders.map(Order.fromDto),
    queues: {},
    events: [],
    now
  };
  Object.entries(scopeSnapshot.queues).forEach(([code, entries]) => {
    memory.queues[code] = (entries ?? []).map((e) => ({ ...e }));
  });

  const reqCount = Math.max(1, Math.floor(Number(cfg.requests) || 10));
  const simEvents: SimRequestEvent[] = [];
  const perTrain: Record<string, PerTrainStat> = {};
  newTrains.forEach((t) => {
    perTrain[t.code] = { train: t, requests: 0, issued: 0, waiting: 0 };
  });

  newTrains.forEach((t) => {
    const n = t.stationSeq.length;
    for (let r = 0; r < reqCount; r++) {
      const fromIdx = randInt(rng, 0, n - 2);
      const toIdx = randInt(rng, fromIdx + 1, n - 1);
      const outcome = purchaseInMemory(memory, t, fromIdx, toIdx);
      const stat = perTrain[t.code] as PerTrainStat;
      stat.requests++;
      if (outcome.issued) stat.issued++;
      else stat.waiting++;
      simEvents.push({
        trainCode: t.code,
        fromIdx,
        toIdx,
        issued: outcome.issued,
        ...(outcome.issued ? { seatNo: outcome.seatNo ?? 0 } : { position: outcome.position })
      });
    }
  });

  // 3. 订单补丁：新增订单 + 状态被补录改变的既有订单（按 id upsert）
  const snapshotById = new Map(scopeSnapshot.orders.map((d) => [d.id, d]));
  const changedOrders = memory.orders.filter((o) => {
    const before = snapshotById.get(o.id);
    if (!before) return true;
    return before.status !== o.status || (before.seatNo ?? null) !== o.seatNo;
  });

  let totalRequests = 0;
  let totalIssued = 0;
  let totalWaiting = 0;
  Object.keys(perTrain).forEach((code) => {
    const st = perTrain[code] as PerTrainStat;
    totalRequests += st.requests;
    totalIssued += st.issued;
    totalWaiting += st.waiting;
  });

  return {
    result: {
      ok: true,
      trains: newTrains,
      summaryData: {
        perTrain,
        events: simEvents,
        totalRequests,
        totalIssued,
        totalWaiting,
        issuedRate: totalRequests ? (totalIssued / totalRequests) * 100 : 0,
        usedSeed: seed,
        elapsedMs: Math.max(0, Math.round(nowMs() - t0))
      }
    },
    patch: {
      orders: changedOrders.map((o) => o.toDto()),
      queueStrategy: 'replace-codes',
      queues: memory.queues, // 受影响车次全量队列（含既有候补被兑现后的出队）
      events: memory.events
    }
  };
}
