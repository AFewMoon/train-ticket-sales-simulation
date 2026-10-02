/* 启动对账入口：算法已迁入 src/domain/engine/ticketing-engine.applyReconcile，
   本函数保留原签名作为兼容入口（main.ts / 测试使用）。 */

import type { TicketingService } from './ticketing-service';
import type { TrainService } from './train-service';

export interface ReconciliationResult {
  fulfilled: number;
}

export function scanAllTrains(ticketing: TicketingService, _trainService: TrainService): ReconciliationResult {
  return ticketing.reconcile();
}
