/* 仿真应用服务：持久化与编排收口层。
   v3.0 起批量生成与批量购票算法委托 src/domain/engine/simulation-engine（纯函数引擎，
   可运行于 Web Worker 或主线程回退路径）；本服务负责：
   - prepare：解析仿真配置（'__auto__' 自动线路的创建、种子解析）；
   - runSimulation/runSimulationResolved：构建全量快照 → 引擎 → 补丁落盘（批量事务包裹）；
   - cleanupSimulation：按 sim 标记精准回收。
   纯逻辑无 DOM；所有仿真实体带 sim: true 标记，便于一键清理（教训 #8）。 */

import type { IRepository } from '../domain/repository';
import type { Station } from '../domain/model/station';
import type { Line } from '../domain/model/line';
import type { Train } from '../domain/model/train';
import type { Order } from '../domain/model/order';
import type { DomainEvent } from '../domain/model/event';
import type { QueueFile } from '../infrastructure/persistence-shapes';
import type { NumberingService } from '../domain/services/numbering-service';
import type { StationService } from '../domain/services/station-service';
import type { LineService } from '../domain/services/line-service';
import type { TrainService } from '../domain/services/train-service';
import type { TicketingService } from '../domain/services/ticketing-service';
import { applySimulation } from '../domain/engine/simulation-engine';
import type {
  PerTrainStat,
  SimulationConfig,
  SimulationSummaryData
} from '../domain/engine/protocol';
import { AUTO_LINE_ID } from '../domain/engine/protocol';

/* 引擎常量与类型 re-export（UI/测试原从本模块导入） */
export { TYPE_META, TYPE_PREFIX, TYPE_MIN_STOPS, makeRng, typeOfTrain } from '../domain/engine/simulation-engine';
export type { Rng, SimTypeMeta } from '../domain/engine/simulation-engine';
export { AUTO_LINE_ID } from '../domain/engine/protocol';
export type { SimulationConfig, SimRequestEvent, PerTrainStat } from '../domain/engine/protocol';

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface SimulationSummary {
  line: Line;
  trains: Train[];
  perTrain: Record<string, PerTrainStat>;
  events: import('../domain/engine/protocol').SimRequestEvent[];
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

export class SimulationService {
  constructor(
    private readonly stationRepo: IRepository<Station[]>,
    private readonly trainRepo: IRepository<Train[]>,
    private readonly lineRepo: IRepository<Line[]>,
    private readonly orderRepo: IRepository<Order[]>,
    private readonly queueRepo: IRepository<QueueFile>,
    private readonly eventRepo: IRepository<DomainEvent[]>,
    private readonly stations: StationService,
    private readonly lines: LineService,
    _trains: TrainService,
    private readonly ticketing: TicketingService,
    private readonly numbering: NumberingService
  ) {}

  /**
   * 解析仿真配置：
   * - 种子解析（负数 → 随机），保证自动线路命名与引擎使用同一 seed；
   * - '__auto__' 时在主线程创建模拟车站与线路（领域服务 CRUD，非重度计算）。
   */
  prepare(cfg: SimulationConfig): { ok: false; msg: string } | { ok: true; line: Line; cfg: SimulationConfig } {
    const seedVal = !isFinite(cfg.seed) || cfg.seed < 0 ? Math.floor(Math.random() * 2147483647) : Math.floor(cfg.seed);
    const resolved: SimulationConfig = { ...cfg, seed: seedVal };

    if (cfg.lineId === AUTO_LINE_ID) {
      const stationCount = Math.max(4, Math.min(30, Math.floor(Number(cfg.autoStationCount) || 10)));
      const seq: string[] = [];
      for (let s = 0; s < stationCount; s++) {
        const res = this.stations.add('模拟站' + (s + 1) + '-' + seedVal, 'Sim' + (s + 1));
        if (!res.ok) return { ok: false, msg: '生成模拟车站失败：' + res.msg };
        seq.push(res.value.no);
      }
      // 回写 sim 标记（教训 #8：创建路径收口）
      const stationList = this.stationRepo.read();
      stationList.forEach((st) => {
        if ((st.nameEn ?? '').indexOf('Sim') === 0) st.sim = true;
      });
      this.stationRepo.write(stationList);
      const lineRes = this.lines.add('模拟线路-' + seedVal, seq, null, { sim: true });
      if (!lineRes.ok) return { ok: false, msg: '生成模拟线路失败：' + lineRes.msg };
      return { ok: true, line: lineRes.value, cfg: resolved };
    }

    const line = this.lines.get(cfg.lineId);
    if (!line) return { ok: false, msg: '请选择仿真线路' };
    return { ok: true, line, cfg: resolved };
  }

  /** 仿真执行（线路已解析）：全量快照 → 引擎 → 补丁落盘（批量事务包裹，教训 #9） */
  runSimulationResolved(line: Line, cfg: SimulationConfig): SimulationResult {
    const t0 = nowMs();

    this.ticketing.beginBatch();
    try {
      const scope = this.ticketing.buildFullScopeForEngine();
      const outcome = applySimulation(scope, line, cfg, this.numbering.getSeqPools().trainCodes, Date.now());
      if (!outcome.result.ok) {
        return { ok: false, msg: (outcome.result as { ok: false; msg: string }).msg };
      }
      this.ticketing.applyPatch(outcome.patch);

      // 新建车次落盘 + 号码池登记（车次不在订单/队列补丁机制内）
      const allTrains = this.trainRepo.read();
      allTrains.push(...outcome.result.trains);
      this.trainRepo.write(allTrains);
      outcome.result.trains.forEach((t) => this.numbering.registerTrainCode(t.code));

      const summaryData: SimulationSummaryData = outcome.result.summaryData;
      return {
        ok: true,
        summary: {
          line,
          trains: outcome.result.trains,
          perTrain: summaryData.perTrain,
          events: summaryData.events,
          totalRequests: summaryData.totalRequests,
          totalIssued: summaryData.totalIssued,
          totalWaiting: summaryData.totalWaiting,
          issuedRate: summaryData.issuedRate,
          usedSeed: summaryData.usedSeed,
          // 与原实现一致：耗时包含自动线路创建等编排开销
          elapsedMs: Math.max(0, Math.round(nowMs() - t0))
        }
      };
    } finally {
      this.ticketing.endBatch();
    }
  }

  /** 兼容入口：配置解析 + 执行 */
  runSimulation(cfg: SimulationConfig): SimulationResult {
    const prepared = this.prepare(cfg);
    if (!prepared.ok) return prepared;
    return this.runSimulationResolved(prepared.line, prepared.cfg);
  }

  /* ---------- 清理：以 sim 车次集合为锚精准回收 ---------- */

  cleanupSimulation(): { stations: number; orders: number; events: number } {
    // sim 车次 code 集合：清理范围的锚。订单删除条件 = sim 标记 或 车次属于集合
    // ——双保险（教训 #8：存量无标记订单——sim 标记收口前经购票路径创建——也能被回收）
    const simCodes = new Set(this.trainRepo.read().filter((t) => t.sim).map((t) => t.code));

    // 1) 删 sim 关联订单（含 CANCELLED 历史单），避免悬空「未知车次」占位
    const orders = this.orderRepo.read();
    const keptOrders = orders.filter((o) => !o.sim && !simCodes.has(o.trainCode));
    const removedOrders = orders.length - keptOrders.length;
    this.orderRepo.write(keptOrders);

    // 2) 删 sim 车次（此时已无订单引用）
    this.trainRepo.write(this.trainRepo.read().filter((t) => !t.sim));

    // 3) 删 sim 车次的候补队列条目（整段移除，不等下次启动对账）
    if (simCodes.size) {
      const qf = this.queueRepo.read();
      simCodes.forEach((code) => delete qf.trains[code]);
      this.queueRepo.write(qf);
    }

    // 4) 事件时间线：剔除 trainCode 属于 sim 车次的记录（已删车次的购票/出票事件不再显示）
    const events = this.eventRepo.read();
    const keptEvents = events.filter((ev) => !simCodes.has(ev.trainCode));
    const removedEvents = events.length - keptEvents.length;
    this.eventRepo.write(keptEvents);

    // 5) 删 sim 线路（此时已无车次挂接）与 sim 车站（站序无引用）
    this.lineRepo.write(this.lineRepo.read().filter((l) => !l.sim));
    const removedNos = new Set<string>();
    this.stations.list().forEach((st) => {
      if (st.sim) removedNos.add(st.no);
    });
    this.stationRepo.write(this.stations.list().filter((st) => !st.sim));

    // 号码池回收重建
    this.numbering.rebuildSeqPools();
    return { stations: removedNos.size, orders: removedOrders, events: removedEvents };
  }
}
