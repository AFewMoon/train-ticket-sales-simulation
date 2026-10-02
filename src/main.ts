/* 应用初始化：退役键清理 → 种子化内置线路 → Worker 计算网关装配 → 对账修复 →
   号码池重建 → 绑定与首渲染。
   对账与后续购票/退票/仿真的重度计算经网关发起（Web Worker 优先，失败自动直算）。 */

import { getContainer } from './container';
import { removeLegacyKeys } from './infrastructure/keys';
import { attachWorkerCompute } from './application/compute-gateway';
import { bindAll, renderAll, switchTab } from './ui/ui';

document.addEventListener('DOMContentLoaded', async () => {
  const c = getContainer();

  // 移除已退役实体的残留键（教训 #21：全量引用清扫）
  removeLegacyKeys(c.storage);

  // 内置「四纵四横」线路与大/小站标记（仅首次运行种子化一次，版本不匹配自动迁移）
  c.seeder.seedIfEmpty();

  // 计算网关升级为 Web Worker（失败自动保持主线程直算）
  await attachWorkerCompute(c.compute, c.transport, c.ticketing, c.simulation);

  // 数据修复：候补队列与订单对账（旧结构探测、悬空出队、缺失补插）后统一补录
  await c.compute.current.reconcile();
  c.numbering.rebuildSeqPools();

  bindAll();
  renderAll();
  switchTab('sim');
});
