/* 应用初始化：载入数据、种子化内置线路、首次渲染、标签切换入口 */
(function (global) {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    // 内置「四纵四横」线路与大/小站标记（仅首次运行种子化一次）
    global.Builtin.seedBuiltinIfEmpty();

    // 数据修复：对已有候补订单重新扫描一次出票（处理历史遗留）
    global.Ticketing.scanAllTrains();
    global.Domain.rebuildSeqPools();

    global.UI.bindAll();
    global.UI.renderAll();
    global.UI.switchTab('stations');
  });
})(window);
