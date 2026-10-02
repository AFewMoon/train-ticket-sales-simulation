/* 应用初始化：IndexedDB 存储就绪 → 注入容器与 UI → 退役键清理 → 种子化内置线路 →
   Worker 计算网关装配 → 退役字头清理（非 G/D 车次）→ 对账修复 → 号码池重建 → 绑定与首渲染。
   存储为 IndexedDB 内存镜像（失败回退 localStorage，见 infrastructure/storage.ts）。
   注意：镜像预热是异步的，且单文件 IIFE 中动态 import 不会推迟 ui.ts 模块求值，
   故 ui.ts 的容器必须经 initUi 延迟注入（教训 #32），不能在模块顶层取。 */

import { initDefaultContainer } from './container';
import { createBrowserStorageAsync } from './infrastructure/storage';
import { KEYS, removeLegacyKeys } from './infrastructure/keys';
import { createRepository } from './infrastructure/local-storage-repository';
import { APP_VERSION } from './version';
import { attachWorkerCompute } from './application/compute-gateway';
import { purgeNonGDTrains } from './domain/services/reconciliation';
import { applySimParamsFromHash, bindAll, initUi, renderAll, switchTab } from './ui/ui';

document.addEventListener('DOMContentLoaded', async () => {
  // 存储升级：await IndexedDB 镜像预热（含 localStorage 旧数据一次性迁移）
  const storage = await createBrowserStorageAsync();
  const c = initDefaultContainer(storage);
  initUi(c);

  // 移除已退役实体的残留键（教训 #21：全量引用清扫）
  removeLegacyKeys(c.storage);

  // 应用版本落盘：仅在变更时写入，记录「数据最后由哪个版本写入」（与 SEED_VERSION 互补）
  const versionRepo = createRepository(c.storage, KEYS.appVersion);
  if (versionRepo.read() !== APP_VERSION) versionRepo.write(APP_VERSION);

  // 内置「四纵四横」线路与大/小站标记（仅首次运行种子化一次，版本不匹配自动迁移）
  c.seeder.seedIfEmpty();

  // 计算网关升级为 Web Worker（失败自动保持主线程直算）
  await attachWorkerCompute(c.compute, c.transport, c.ticketing, c.simulation);

  // 退役字头清理：删除非 G/D（K 字头及异常串）车次，连带订单与候补队列（教训 #21：退役实体全量清扫）
  purgeNonGDTrains(c.trains, c.ticketing);

  // 数据修复：候补队列与订单对账（旧结构探测、悬空出队、缺失补插）后统一补录
  await c.compute.current.reconcile();
  c.numbering.rebuildSeqPools();

  bindAll();
  renderAll();
  // 链接分享：解析 hash 中的仿真参数回填表单（在 renderAll 之后——依赖线路下拉选项已就绪）
  applySimParamsFromHash();
  switchTab('sim');
});
