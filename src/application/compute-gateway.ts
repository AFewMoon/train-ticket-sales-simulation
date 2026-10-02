/* 计算网关：主线程发起重度计算请求、接收结果与补丁的唯一入口。
   - DirectComputeGateway：主线程直算（调用 TicketingService/SimulationService 内部
     的事务感知引擎包装），Worker 不可用时的回退路径；
   - WorkerComputeGateway：postMessage RPC 到 engine.worker，快照由 EngineTransport
     构建、补丁由其落盘；Worker 出错（onerror/响应失败）时自动降级为直算；
   两条路径共用同一套纯函数引擎，行为等价。 */

import type { EngineRequest, EngineResponse, PurchaseResult, RefundResult, RefundSimResult, SimulationConfig } from '../domain/engine/protocol';
import type { SimulationResult } from './simulation-service';
import type { Line } from '../domain/model/line';
import type { EngineTransport } from './engine-transport';
import type { SimulationService } from './simulation-service';
import type { TicketingService } from '../domain/services/ticketing-service';

export interface ComputeGateway {
  purchase(trainCode: string, fromIdx: number, toIdx: number): Promise<PurchaseResult>;
  refundOrder(orderId: string): Promise<RefundResult>;
  refundSimulation(ratePercent: number): Promise<RefundSimResult>;
  reconcile(): Promise<{ fulfilled: number }>;
  /** 线路已解析（auto 线路已由主线程 prepare 创建）的仿真执行 */
  simulateResolved(line: Line, cfg: SimulationConfig): Promise<SimulationResult>;
}

/* ---------- 主线程直算（回退路径） ---------- */

export class DirectComputeGateway implements ComputeGateway {
  constructor(
    private readonly ticketing: TicketingService,
    private readonly simulation: SimulationService
  ) {}

  async purchase(trainCode: string, fromIdx: number, toIdx: number): Promise<PurchaseResult> {
    return this.ticketing.purchase(trainCode, fromIdx, toIdx);
  }

  async refundOrder(orderId: string): Promise<RefundResult> {
    return this.ticketing.refundOrder(orderId);
  }

  async refundSimulation(ratePercent: number): Promise<RefundSimResult> {
    return this.ticketing.refundSimulation(ratePercent);
  }

  async reconcile(): Promise<{ fulfilled: number }> {
    return this.ticketing.reconcile();
  }

  async simulateResolved(line: Line, cfg: SimulationConfig): Promise<SimulationResult> {
    return this.simulation.runSimulationResolved(line, cfg);
  }
}

/* ---------- Worker RPC ---------- */

interface PendingEntry {
  resolve: (res: EngineResponse) => void;
  reject: (err: Error) => void;
}

export class WorkerComputeGateway implements ComputeGateway {
  private worker: Worker;
  private pending = new Map<number, PendingEntry>();
  private seq = 0;
  private failed = false;
  private readonly direct: DirectComputeGateway;

  constructor(
    private readonly transport: EngineTransport,
    ticketing: TicketingService,
    simulation: SimulationService,
    createWorker: () => Worker
  ) {
    this.direct = new DirectComputeGateway(ticketing, simulation);
    this.worker = createWorker(); // 构造失败由调用方 try/catch 回退
    this.worker.onmessage = (e: MessageEvent) => {
      const res = e.data as EngineResponse;
      const entry = this.pending.get(res.id);
      if (!entry) return;
      this.pending.delete(res.id);
      entry.resolve(res);
    };
    this.worker.onerror = () => {
      // Worker 不可用：拒绝在途请求并永久降级为直算
      this.failed = true;
      this.pending.forEach((p) => p.reject(new Error('引擎 Worker 已失效，本次请求被取消')));
      this.pending.clear();
      try {
        this.worker.terminate();
      } catch {
        /* ignore */
      }
    };
  }

  private rpc(req: EngineRequest): Promise<EngineResponse> {
    return new Promise<EngineResponse>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      try {
        this.worker.postMessage(req);
      } catch (err) {
        this.pending.delete(req.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Worker 失败判定：onerror 或 rpc 异常时触发直算降级 */
  private isWorkerFailure(err: unknown): boolean {
    return err instanceof Error && err.message.indexOf('Worker') !== -1;
  }

  private async execute(build: (id: number) => EngineRequest): Promise<Extract<EngineResponse, { ok: true }>> {
    const req = build(++this.seq);
    const res = await this.rpc(req);
    if (!res.ok) throw new Error(res.msg);
    this.transport.applyPatch(res.patch);
    return res;
  }

  async purchase(trainCode: string, fromIdx: number, toIdx: number): Promise<PurchaseResult> {
    const direct = (): Promise<PurchaseResult> => this.direct.purchase(trainCode, fromIdx, toIdx);
    if (this.failed) return direct();
    try {
      const res = await this.execute((id) => ({
        id,
        kind: 'purchase',
        scope: this.transport.buildTrainScope(trainCode),
        trainCode,
        fromIdx,
        toIdx,
        now: Date.now()
      }));
      return res.result as PurchaseResult;
    } catch (err) {
      if (this.isWorkerFailure(err)) return direct();
      throw err;
    }
  }

  async refundOrder(orderId: string): Promise<RefundResult> {
    const direct = (): Promise<RefundResult> => this.direct.refundOrder(orderId);
    if (this.failed) return direct();
    try {
      const res = await this.execute((id) => ({
        id,
        kind: 'refund',
        scope: this.transport.buildTrainScope(this.transport.findOrderDto(orderId)?.trainCode ?? ''),
        orderId,
        now: Date.now()
      }));
      return res.result as RefundResult;
    } catch (err) {
      if (this.isWorkerFailure(err)) return direct();
      throw err;
    }
  }

  async refundSimulation(ratePercent: number): Promise<RefundSimResult> {
    const direct = (): Promise<RefundSimResult> => this.direct.refundSimulation(ratePercent);
    if (this.failed) return direct();
    try {
      const res = await this.execute((id) => ({
        id,
        kind: 'refundSimulation',
        scope: this.transport.buildFullScope(),
        rate: ratePercent,
        now: Date.now()
      }));
      return res.result as RefundSimResult;
    } catch (err) {
      if (this.isWorkerFailure(err)) return direct();
      throw err;
    }
  }

  async reconcile(): Promise<{ fulfilled: number }> {
    const direct = (): Promise<{ fulfilled: number }> => this.direct.reconcile();
    if (this.failed) return direct();
    try {
      const res = await this.execute((id) => ({
        id,
        kind: 'reconcile',
        scope: this.transport.buildFullScope(),
        now: Date.now()
      }));
      return res.result as { fulfilled: number };
    } catch (err) {
      if (this.isWorkerFailure(err)) return direct();
      throw err;
    }
  }

  async simulateResolved(line: Line, cfg: SimulationConfig): Promise<SimulationResult> {
    const direct = (): Promise<SimulationResult> => this.direct.simulateResolved(line, cfg);
    if (this.failed) return direct();
    try {
      const res = await this.execute((id) => ({
        id,
        kind: 'simulate',
        scope: this.transport.buildFullScope(),
        line,
        cfg,
        seqTrainCodes: this.transport.seqTrainCodes(),
        now: Date.now()
      }));
      const result = res.result as Extract<EngineResponse, { ok: true; kind: 'simulate' }>['result'];
      if (!result.ok) return { ok: false, msg: result.msg };

      // 落盘新建车次并登记号码池（补丁机制只覆盖 orders/queues/events）
      this.transport.registerTrains(result.trains);
      return {
        ok: true,
        summary: {
          line,
          trains: result.trains,
          ...result.summaryData
        }
      };
    } catch (err) {
      if (this.isWorkerFailure(err)) return direct();
      throw err;
    }
  }
}

/* ---------- 网关持有者与 Worker 装配 ---------- */

export interface ComputeGatewayHolder {
  current: ComputeGateway;
}

/**
 * 尝试装配 Worker 计算网关（?worker&inline 内联为 blob，IIFE 单文件自包含）。
 * 成功返回 true 并替换 holder；任何失败（环境无 Worker / 构造异常）保持直算网关。
 * 仅由 main.ts 调用（动态 import，保证 Vitest node 环境不触碰 Worker 模块）。
 */
export async function attachWorkerCompute(
  holder: ComputeGatewayHolder,
  transport: EngineTransport,
  ticketing: TicketingService,
  simulation: SimulationService
): Promise<boolean> {
  if (typeof Worker === 'undefined') return false;
  try {
    const mod = (await import('../workers/engine.worker?worker&inline')) as {
      default: new () => Worker;
    };
    const probe = new mod.default();
    probe.terminate();
    holder.current = new WorkerComputeGateway(transport, ticketing, simulation, () => new mod.default());
    // 可观测标记（浏览器回归用）：当前计算路径
    (globalThis as { __ttsCompute?: string }).__ttsCompute = 'worker';
    return true;
  } catch {
    return false;
  }
}
