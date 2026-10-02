/* 仿真应用服务：基于一条线路自动生成三类车次（直达车/大站快车/隔站停车）、
   批量购票请求复用 TicketingService.purchase（逐单区间适配出票）跑完整流程，并汇总统计。
   纯逻辑无 DOM；所有仿真实体带 sim: true 标记，便于一键清理（教训 #8：创建路径收口打标记）。 */

import type { IRepository } from '../domain/repository';
import type { Station } from '../domain/model/station';
import type { Line } from '../domain/model/line';
import type { Train } from '../domain/model/train';
import { SimType } from '../domain/model/train';
import type { Order } from '../domain/model/order';
import type { NumberingService } from '../domain/services/numbering-service';
import type { StationService } from '../domain/services/station-service';
import type { LineService } from '../domain/services/line-service';
import type { TrainService } from '../domain/services/train-service';
import type { TicketingService } from '../domain/services/ticketing-service';

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

/* ---------- 三类车次生成（均挂接线路，站序为线路子序列） ---------- */

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
const TYPE_MIN_STOPS: Record<SimType, number> = {
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

/* ---------- 配置与结果 ---------- */

export interface SimulationConfig {
  /** 仿真线路 ID；'__auto__' 表示自动生成一条模拟线路 */
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

export interface SimulationSummary {
  line: Line;
  trains: Train[];
  perTrain: Record<string, PerTrainStat>;
  events: SimRequestEvent[];
  totalRequests: number;
  totalIssued: number;
  totalWaiting: number;
  issuedRate: number;
  usedSeed: number;
  elapsedMs: number;
}

export type SimulationResult =
  | { ok: false; msg: string }
  | { ok: true; summary: SimulationSummary };

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class SimulationService {
  constructor(
    private readonly stationRepo: IRepository<Station[]>,
    private readonly trainRepo: IRepository<Train[]>,
    private readonly lineRepo: IRepository<Line[]>,
    private readonly orderRepo: IRepository<Order[]>,
    private readonly stations: StationService,
    private readonly lines: LineService,
    private readonly trains: TrainService,
    private readonly ticketing: TicketingService,
    private readonly numbering: NumberingService
  ) {}

  private generateTrains(line: Line, cfg: SimulationConfig, rng: Rng): Train[] {
    const plan: Array<[SimType, number]> = [
      [SimType.Direct, cfg.countDirect],
      [SimType.Express, cfg.countExpress],
      [SimType.Skip, cfg.countSkip]
    ];
    const created: Train[] = [];
    plan.forEach(([type, rawCount]) => {
      const count = Math.max(0, Math.floor(Number(rawCount) || 0));
      const minStops = TYPE_MIN_STOPS[type];
      for (let i = 0; i < count; i++) {
        const stops = pickStops(rng, line, type);
        if (!stops || stops.length < minStops) continue;
        const res = this.trains.add(stops, cfg.seats, line.id, TYPE_PREFIX[type], null);
        if (!res.ok) continue;
        // 为仿真车次补充类型标记（教训 #8：创建路径收口处统一打 sim 标记并持久化）
        const allTrains = this.trains.list();
        const t = allTrains.find((x) => x.code === res.value.code);
        if (t) {
          t.simType = type;
          t.sim = true;
          this.trainRepo.write(allTrains);
        }
        created.push(t ?? res.value);
      }
    });
    return created;
  }

  runSimulation(cfg: SimulationConfig): SimulationResult {
    // 运算耗时计时起点（performance.now 不可用时回退 Date.now，保证 file:// 直开可靠）
    const t0 = nowMs();

    // 种子：负数表示随机种子，其余值结果可复现
    const seed = !isFinite(cfg.seed) || cfg.seed < 0 ? Math.floor(Math.random() * 2147483647) : Math.floor(cfg.seed);

    // 1. 线路：选择已有线路，或自动生成一条 sim 线路
    let line: Line;
    if (cfg.lineId === AUTO_LINE_ID) {
      const stationCount = Math.max(4, Math.min(30, Math.floor(Number(cfg.autoStationCount) || 10)));
      const seq: string[] = [];
      for (let s = 0; s < stationCount; s++) {
        const res = this.stations.add('模拟站' + (s + 1) + '-' + seed, 'Sim' + (s + 1));
        if (!res.ok) return { ok: false, msg: '生成模拟车站失败：' + res.msg };
        seq.push(res.value.no);
      }
      // 回写 sim 标记
      const stationList = this.stationRepo.read();
      stationList.forEach((st) => {
        if ((st.nameEn ?? '').indexOf('Sim') === 0) st.sim = true;
      });
      this.stationRepo.write(stationList);
      const lineRes = this.lines.add('模拟线路-' + seed, seq, null, { sim: true });
      if (!lineRes.ok) return { ok: false, msg: '生成模拟线路失败：' + lineRes.msg };
      line = lineRes.value;
    } else {
      const found = this.lines.get(cfg.lineId);
      if (!found) return { ok: false, msg: '请选择仿真线路' };
      line = found;
    }

    const rng = makeRng(seed);

    // 2~3. 批量事务：批次内 orders/queues/events 全部走内存缓存，结束时一次性落盘
    let trains: Train[] = [];
    const events: SimRequestEvent[] = [];
    const simOrderIds = new Set<string>();
    const perTrain: Record<string, PerTrainStat> = {};

    this.ticketing.beginBatch();
    try {
      trains = this.generateTrains(line, cfg, rng);
      if (!trains.length) {
        return { ok: false, msg: '未能生成任何车次，请检查各类车次数参数' };
      }

      // 编排购票请求：每车次 requests 条，随机合法区间
      const reqCount = Math.max(1, Math.floor(Number(cfg.requests) || 10));
      trains.forEach((t) => {
        perTrain[t.code] = { train: t, requests: 0, issued: 0, waiting: 0 };
      });

      trains.forEach((t) => {
        const n = t.stationSeq.length;
        for (let r = 0; r < reqCount; r++) {
          const fromIdx = randInt(rng, 0, n - 2);
          const toIdx = randInt(rng, fromIdx + 1, n - 1);
          const res = this.ticketing.purchase(t.code, fromIdx, toIdx);
          const stat = perTrain[t.code] as PerTrainStat;
          stat.requests++;
          if (res.ok && res.issued) stat.issued++;
          else if (res.ok) stat.waiting++;
          if (res.ok && res.order) {
            simOrderIds.add(res.order.id);
            events.push({
              trainCode: t.code,
              fromIdx,
              toIdx,
              issued: res.issued,
              ...(res.issued ? { seatNo: res.seatNo } : { position: res.position })
            });
          }
        }
      });
    } finally {
      this.ticketing.endBatch();
    }

    // 批次落盘后，为本次仿真的订单统一打 sim 标记（教训 #8：一次写回收口）
    const orderList = this.orderRepo.read();
    let marked = false;
    orderList.forEach((o) => {
      if (simOrderIds.has(o.id)) {
        o.sim = true;
        marked = true;
      }
    });
    if (marked) this.orderRepo.write(orderList);

    // 4. 汇总
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
      ok: true,
      summary: {
        line,
        trains,
        perTrain,
        events,
        totalRequests,
        totalIssued,
        totalWaiting,
        issuedRate: totalRequests ? (totalIssued / totalRequests) * 100 : 0,
        usedSeed: seed,
        elapsedMs: Math.max(0, Math.round(nowMs() - t0))
      }
    };
  }

  /* ---------- 清理：按 sim 标记精准回收 ---------- */

  cleanupSimulation(): { stations: number } {
    // 1) 删 sim 订单（含已取消的历史订单）
    this.orderRepo.write(this.orderRepo.read().filter((o) => !o.sim));
    // 2) 删 sim 车次（此时已无订单引用）
    this.trainRepo.write(this.trainRepo.read().filter((t) => !t.sim));
    // 3) 删 sim 线路（此时已无车次挂接）与 sim 车站（站序无引用）
    this.lineRepo.write(this.lineRepo.read().filter((l) => !l.sim));
    const removedNos = new Set<string>();
    this.stations.list().forEach((st) => {
      if (st.sim) removedNos.add(st.no);
    });
    this.stationRepo.write(this.stations.list().filter((st) => !st.sim));
    // 号码池回收重建
    this.numbering.rebuildSeqPools();
    return { stations: removedNos.size };
  }
}
