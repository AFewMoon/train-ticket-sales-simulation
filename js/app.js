/* 应用初始化：载入数据、首次渲染、标签切换入口 */
(function (global) {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    // 数据修复：对已有候补订单重新扫描一次出票（处理历史遗留）
    global.Ticketing.scanAllTrains();
    global.Domain.rebuildSeqPools();

    global.UI.bindAll();
    global.UI.renderAll();
    global.UI.switchTab('stations');
  });
})(window);
