/* 启动数据修复与对账入口：
   - purgeNonGDTrains：退役字头清理（v3.1 起车次号仅允许 G/D）——删除全部非合法
     车次号（K 字头及异常串）的车次，连带其订单（含已取消历史）与候补队列条目，
     避免悬空引用；号码池随 main.ts 既有 rebuildSeqPools 重建，被删号码不再复用。
   - scanAllTrains：算法已迁入 src/domain/engine/ticketing-engine.applyReconcile，
     本函数保留原签名作为兼容入口（main.ts / 测试使用）。 */

import { isValidTrainCode } from '../model/train';
import type { TicketingService } from './ticketing-service';
import type { TrainService } from './train-service';

export interface ReconciliationResult {
  fulfilled: number;
}

export function scanAllTrains(ticketing: TicketingService, _trainService: TrainService): ReconciliationResult {
  return ticketing.reconcile();
}

/**
 * 清理退役字头（非 G/D）车次：单次线性扫描车次/订单/队列，幂等可重入。
 * 返回被清理的车次号列表（无清理时为空数组）。
 */
export function purgeNonGDTrains(trains: TrainService, ticketing: TicketingService): string[] {
  const invalid = trains.list().filter((t) => !isValidTrainCode(t.code));
  if (!invalid.length) return [];
  const codes = invalid.map((t) => t.code);
  trains.removeByCodes(codes);
  const q = ticketing.currentQueues();
  codes.forEach((code) => {
    delete q.trains[code];
  });
  ticketing.saveQueues(q);
  return codes;
}
