/* 启动对账（幂等）：
   - 旧版 buckets 结构或已不存在车次的队列：废弃重建（教训 #16：显式形状探测）；
   - 队列内悬空条目（订单已删/已出票/已取消）移除、缺失候补按 createdAt 补入；
   - 随后对每个有候补的车次做一次补录扫描。
   注意教训 #13：对账入口必须幂等可重入，任意中间状态收敛。 */

import { OrderStatus, type Order } from '../model/order';
import type { QueueEntry } from '../../infrastructure/persistence-shapes';
import type { TicketingService } from './ticketing-service';
import type { TrainService } from './train-service';

export interface ReconciliationResult {
  fulfilled: number;
}

export function scanAllTrains(ticketing: TicketingService, trainService: TrainService): ReconciliationResult {
  const orders = ticketing.currentOrders();
  const waitingByTrain = new Map<string, Order[]>();
  const waitingIds = new Set<string>();
  orders.forEach((o) => {
    if (o.status !== OrderStatus.WAITING) return;
    const list = waitingByTrain.get(o.trainCode);
    if (list) list.push(o);
    else waitingByTrain.set(o.trainCode, [o]);
    waitingIds.add(o.id);
  });

  const q = ticketing.currentQueues();
  let qChanged = false;

  // 文件级归一化：旧 { buckets: ... } 或缺失 trains 字段的任意形状 → 重置为新结构
  const qFile = q as unknown as Record<string, unknown>;
  if ('buckets' in qFile || !q.trains || typeof q.trains !== 'object' || Array.isArray(q.trains)) {
    delete qFile.buckets;
    q.trains = {};
    qChanged = true;
  }

  // 旧结构探测：非数组且带 buckets 字段 → 整体废弃重建
  const trainsRecord = q.trains as Record<string, unknown>;
  Object.keys(trainsRecord).forEach((code) => {
    const queue = trainsRecord[code];
    const legacy = queue !== null && typeof queue === 'object' && !Array.isArray(queue) && 'buckets' in queue;
    if (legacy || (!trainService.get(code) && !waitingByTrain.has(code))) {
      delete q.trains[code];
      qChanged = true;
    }
  });

  // 悬空条目出队
  Object.keys(q.trains).forEach((code) => {
    const queue = q.trains[code];
    if (!queue) return;
    for (let i = queue.length - 1; i >= 0; i--) {
      const entry = queue[i];
      if (!entry || !waitingIds.has(entry.id)) {
        queue.splice(i, 1);
        qChanged = true;
      }
    }
  });

  // 缺失候补按 createdAt 二分补插
  waitingByTrain.forEach((list, code) => {
    if (!trainService.get(code)) return;
    list.forEach((o) => {
      const queue = q.trains[code] ?? (q.trains[code] = []);
      const exists = queue.some((e) => e.id === o.id);
      if (!exists) {
        const entry: QueueEntry = {
          id: o.id,
          fromIdx: o.fromIdx,
          toIdx: o.toIdx,
          createdAt: o.createdAt
        };
        let lo = 0;
        let hi = queue.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((queue[mid] as QueueEntry).createdAt < entry.createdAt) lo = mid + 1;
          else hi = mid;
        }
        queue.splice(lo, 0, entry);
        qChanged = true;
      }
    });
  });

  if (qChanged) ticketing.saveQueues(q);

  const fulfilled = ticketing.processAllWaiting();
  return { fulfilled };
}
