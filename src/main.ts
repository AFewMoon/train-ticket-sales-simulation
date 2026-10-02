/* 应用初始化：退役键清理 → 种子化内置线路 → 对账修复 → 号码池重建 → 绑定与首渲染 */

import { getContainer } from './container';
import { removeLegacyKeys } from './infrastructure/keys';
import { scanAllTrains } from './domain/services/reconciliation';
import { bindAll, renderAll, switchTab } from './ui/ui';

document.addEventListener('DOMContentLoaded', () => {
  const c = getContainer();

  // 移除已退役实体的残留键（教训 #21：全量引用清扫）
  removeLegacyKeys(c.storage);

  // 内置「四纵四横」线路与大/小站标记（仅首次运行种子化一次，版本不匹配自动迁移）
  c.seeder.seedIfEmpty();

  // 数据修复：候补队列与订单对账（旧结构探测、悬空出队、缺失补插）后统一补录
  scanAllTrains(c.ticketing, c.trains);
  c.numbering.rebuildSeqPools();

  bindAll();
  renderAll();
  switchTab('sim');
});
