/* 引擎调度器：EngineRequest → 引擎函数 → EngineResponse 的纯映射。
   Worker 入口（engine.worker.ts）与测试回环（直接调用本函数）共用，
   保证 Worker 路径与主线程直算路径走完全相同的引擎代码。 */

import { applyPurchase, applyRefund, applyRefundSimulation, applyReconcile } from './ticketing-engine';
import { applySimulation } from './simulation-engine';
import type { EngineRequest, EngineResponse } from './protocol';

export function handleEngineRequest(req: EngineRequest): EngineResponse {
  try {
    switch (req.kind) {
      case 'purchase': {
        const outcome = applyPurchase(req.scope, req.trainCode, req.fromIdx, req.toIdx, req.now);
        return { id: req.id, ok: true, kind: 'purchase', result: outcome.result, patch: outcome.patch };
      }
      case 'refund': {
        const outcome = applyRefund(req.scope, req.orderId, req.now);
        return { id: req.id, ok: true, kind: 'refund', result: outcome.result, patch: outcome.patch };
      }
      case 'refundSimulation': {
        const outcome = applyRefundSimulation(req.scope, req.rate, req.now);
        return { id: req.id, ok: true, kind: 'refundSimulation', result: outcome.result, patch: outcome.patch };
      }
      case 'reconcile': {
        const outcome = applyReconcile(req.scope, req.now);
        return { id: req.id, ok: true, kind: 'reconcile', result: outcome.result, patch: outcome.patch };
      }
      case 'simulate': {
        const outcome = applySimulation(req.scope, req.line, req.cfg, req.seqTrainCodes, req.now);
        return { id: req.id, ok: true, kind: 'simulate', result: outcome.result, patch: outcome.patch };
      }
      default: {
        const unknown = req as { id?: number };
        return { id: unknown.id ?? -1, ok: false, msg: '未知引擎请求类型' };
      }
    }
  } catch (err) {
    return { id: (req as { id?: number }).id ?? -1, ok: false, msg: String((err as Error)?.message ?? err) };
  }
}
