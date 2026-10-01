/* 出票算法层（逐单区间适配 · 在线版）：
   —— 规则：候补订单按 createdAt 升序逐单尝试补录，任一座位的目标区间
      [fromIdx, toIdx) 完全空闲即出票到该座位——允许座位存在空洞，最大化座位利用率。
   —— 在线机制：候补队列按车次持久化（tts:queues，单条时戳有序列表），
      入队 O(log W)、出票 O(1) 移除；退票后自动按时间戳补录。
   —— 座位分配与容量统计只遍历「已占用座位集合」，复杂度与座位数上限解耦（支持 INT_MAX）。
   —— 批量事务：beginBatch()/endBatch() 供仿真等高频场景将 orders/queues/events
      的读写收敛到内存缓存、结束时一次性落盘。
   —— 事件流：购票/出票/候补/退票/兑现写入 tts:events（上限 500）。 */
(function (global) {
  'use strict';

  var K = global.Storage.KEYS;
  var Domain = global.Domain;

  var EVENTS_CAP = 500;

  /* ================= 批量事务缓冲 ================= */

  var batch = null; // { orders, queues, events, dirtyOrders, dirtyQueues, dirtyEvents }

  function beginBatch() {
    if (batch) return;
    batch = {
      orders: global.Storage.read(K.orders, []),
      queues: global.Storage.read(K.queues, { trains: {} }),
      events: global.Storage.read(K.events, []),
      dirtyOrders: false,
      dirtyQueues: false,
      dirtyEvents: false
    };
  }

  function endBatch() {
    if (!batch) return;
    if (batch.dirtyOrders) global.Storage.write(K.orders, batch.orders);
    if (batch.dirtyQueues) global.Storage.write(K.queues, batch.queues);
    if (batch.dirtyEvents) global.Storage.write(K.events, batch.events);
    batch = null;
  }

  function getOrders() { return batch ? batch.orders : global.Storage.read(K.orders, []); }
  function saveOrders(orders) {
    if (batch) { batch.orders = orders; batch.dirtyOrders = true; }
    else global.Storage.write(K.orders, orders);
  }
  function getQueues() { return batch ? batch.queues : global.Storage.read(K.queues, { trains: {} }); }
  function saveQueues(q) {
    if (batch) { batch.queues = q; batch.dirtyQueues = true; }
    else global.Storage.write(K.queues, q);
  }
  function addEventRecord(ev) {
    var events = batch ? batch.events : global.Storage.read(K.events, []);
    events.push(ev);
    if (events.length > EVENTS_CAP) events = events.slice(events.length - EVENTS_CAP);
    if (batch) { batch.events = events; batch.dirtyEvents = true; }
    else global.Storage.write(K.events, events);
  }

  /* ================= 事件流 ================= */

  var EVENT_TYPES = {
    purchase: { label: '购票', cls: 'ev-purchase' },
    issued: { label: '出票', cls: 'ev-issued' },
    waitlisted: { label: '候补', cls: 'ev-waitlisted' },
    refund: { label: '退票', cls: 'ev-refund' },
    fulfilled: { label: '兑现', cls: 'ev-fulfilled' }
  };

  function pushEvent(type, detail, trainCode, orderId) {
    addEventRecord({
      id: Domain.uid('e'),
      ts: Date.now(),
      type: type,
      trainCode: trainCode || '',
      orderId: orderId || '',
      detail: detail
    });
  }

  function listEvents(limit) {
    var events = batch ? batch.events : global.Storage.read(K.events, []);
    return events.slice(-limit).reverse();
  }

  /* ================= 候补队列（在线持久化，时戳有序） ================= */

  function getQueue(q, trainCode) {
    if (!q.trains[trainCode]) q.trains[trainCode] = [];
    return q.trains[trainCode];
  }

  /** 新候补订单入队：O(log W) 定位 + 插入，保持 createdAt 升序 */
  function enqueueOrder(q, order) {
    var queue = getQueue(q, order.trainCode);
    var entry = { id: order.id, fromIdx: order.fromIdx, toIdx: order.toIdx, createdAt: order.createdAt };
    var lo = 0, hi = queue.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (queue[mid].createdAt < entry.createdAt) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, entry);
    return entry;
  }

  /** 按订单从队列移除（出票/取消，幂等） */
  function dequeueOrder(q, order) {
    var queue = q.trains[order.trainCode];
    if (!queue) return;
    var idx = queue.findIndex(function (e) { return e.id === order.id; });
    if (idx !== -1) queue.splice(idx, 1);
  }

  /* ================= 查询 ================= */

  function ordersOfTrain(trainCode) {
    return getOrders().filter(function (o) { return o.trainCode === trainCode; });
  }

  function waitingOrdersOfTrain(trainCode) {
    return ordersOfTrain(trainCode)
      .filter(function (o) { return o.status === 'waiting'; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  function allWaitingOrders() {
    return getOrders().filter(function (o) { return o.status === 'waiting'; });
  }

  /* ================= 座位占用（与座位数上限解耦） ================= */

  /**
   * 将已出票订单按座位分组：{ [seatNo]: [order...] }。
   * 只包含有票的座位——未占用座位不占内存与计算量。
   */
  function groupBySeat(issuedOrders) {
    var bySeat = Object.create(null);
    issuedOrders.forEach(function (o) {
      if (o.seatNo === undefined || o.seatNo === null) return;
      (bySeat[o.seatNo] = bySeat[o.seatNo] || []).push(o);
    });
    return bySeat;
  }

  /** 单座位的分段占用（只统计该座位自己的票段） */
  function seatLoad(seatOrders, stationCount) {
    var diff = new Array(stationCount + 1).fill(0);
    seatOrders.forEach(function (o) {
      diff[o.fromIdx]++;
      diff[o.toIdx]--;
    });
    var load = new Array(Math.max(stationCount - 1, 0)).fill(0);
    var acc = 0;
    for (var i = 0; i < stationCount - 1; i++) {
      acc += diff[i];
      load[i] = acc;
    }
    return load;
  }

  /**
   * 兼容保留：按座位号统计分段占用（旧接口，性能同新实现）。
   */
  function segmentLoad(issuedOrders, stationCount, seatNo) {
    return seatLoad(issuedOrders.filter(function (o) { return o.seatNo === seatNo; }), stationCount);
  }

  /**
   * 为单张订单寻找座位：
   * 1) 逐个「已占用座位」检查目标区间是否完全空闲（O(占用座位数 × S)，与座位上限无关）；
   * 2) 全部冲突时分配最小可用新座位号（未占用座位必然全程空闲）。
   */
  function allocateSeatForOrder(train, issuedOrders, order) {
    var stationCount = train.stationSeq.length;
    var bySeat = groupBySeat(issuedOrders);
    for (var seatNo in bySeat) {
      var load = seatLoad(bySeat[seatNo], stationCount);
      var free = true;
      for (var i = order.fromIdx; i < order.toIdx; i++) {
        if (load[i] > 0) { free = false; break; }
      }
      if (free) return Number(seatNo);
    }
    // 新座位：未占用座位全程空闲，取最小可用编号
    var s = 1;
    while (bySeat[s]) s++;
    return s <= train.seatCount ? s : null;
  }

  /** 车次剩余运力摘要（未占用座位以计数表示，不逐一座位枚举） */
  function capacitySummary(train, orders) {
    var stationCount = train.stationSeq.length;
    var totalSegments = Math.max(stationCount - 1, 0);
    var issued = orders.filter(function (o) { return o.status === 'issued'; });
    var bySeat = groupBySeat(issued);

    var freeSegments = 0;
    var perSeat = [];
    Object.keys(bySeat).forEach(function (seatNo) {
      var load = seatLoad(bySeat[seatNo], stationCount);
      var free = load.filter(function (x) { return x === 0; }).length;
      perSeat.push({ seatNo: Number(seatNo), freeSegments: free });
      freeSegments += free;
    });
    perSeat.sort(function (a, b) { return a.seatNo - b.seatNo; });

    var emptySeatCount = Math.max(train.seatCount - perSeat.length, 0);
    freeSegments += emptySeatCount * totalSegments;

    return {
      totalSegments: totalSegments,
      freeSegments: freeSegments,
      perSeat: perSeat,
      emptySeatCount: emptySeatCount
    };
  }

  /* ================= 补录扫描（单 train，逐单区间适配） ================= */

  /**
   * 按队列时戳升序逐单尝试区间适配：出票即出队并继续尝试后续订单
   * （最大化利用率）；无适配座位则留队。
   * 返回 { issued: [order...], changed: bool }
   */
  function processTrainWaiting(train) {
    var orders = getOrders();
    var orderById = {};
    orders.forEach(function (o) { orderById[o.id] = o; });
    var issued = orders.filter(function (o) { return o.trainCode === train.code && o.status === 'issued'; });

    var q = getQueues();
    var queue = getQueue(q, train.code);

    var result = [];
    var changed = false;
    var kept = [];
    queue.forEach(function (entry) {
      var o = orderById[entry.id];
      if (!o || o.status !== 'waiting') {
        changed = true; // 悬空条目（订单已删/已出票）：出队
        return;
      }
      var seatNo = allocateSeatForOrder(train, issued, o);
      if (seatNo === null) {
        kept.push(entry); // 区间无可放座位：留在队列
        return;
      }
      o.status = 'issued';
      o.seatNo = seatNo;
      issued.push(o);
      result.push(o);
      changed = true;
      pushEvent('fulfilled', '候补补录：' + o.fromIdx + '→' + o.toIdx + ' 分配座位 ' + seatNo, train.code, o.id);
    });
    q.trains[train.code] = kept;

    if (changed) {
      saveOrders(orders);
      saveQueues(q);
    }
    return { issued: result, changed: changed };
  }

  /** 遍历全部有候补的车次执行补录扫描（供手动入口调用），返回兑现总单数 */
  function processAllWaiting() {
    var q = getQueues();
    var fulfilled = 0;
    Domain.listTrains().forEach(function (t) {
      var queue = q.trains[t.code];
      if (queue && queue.length) {
        var res = processTrainWaiting(t);
        fulfilled += res.issued.length;
      }
    });
    return fulfilled;
  }

  /* ================= 购票 / 退票 ================= */

  /**
   * 购票：创建订单 → O(log W) 入队 → 立即对该车次做一次补录扫描。
   * 返回 { ok, issued, seatNo?, position?, order }
   */
  function purchase(trainCode, fromIdx, toIdx) {
    var train = Domain.getTrain(trainCode);
    if (!train) return { ok: false, msg: '车次不存在' };
    if (!Domain.isValidRange(fromIdx, toIdx)) return { ok: false, msg: '非法区间' };
    if (toIdx >= train.stationSeq.length) return { ok: false, msg: '区间超出车次站序' };

    var orders = getOrders();
    var newOrder = {
      id: Domain.uid('o'),
      trainCode: trainCode,
      fromIdx: fromIdx,
      toIdx: toIdx,
      status: 'waiting',
      createdAt: Date.now() + (orders.length % 1000) * 0.001 // 保证同毫秒下排序稳定
    };
    orders.push(newOrder);
    saveOrders(orders);

    // 在线入队 + 补录扫描
    var q = getQueues();
    enqueueOrder(q, newOrder);
    saveQueues(q);
    pushEvent('purchase', '购票请求：' + trainCode + ' ' + fromIdx + '→' + toIdx, trainCode, newOrder.id);

    processTrainWaiting(train);
    var final = getOrders().find(function (o) { return o.id === newOrder.id; });

    if (final && final.status === 'issued') {
      pushEvent('issued', '出票成功：座位 ' + final.seatNo, trainCode, newOrder.id);
      return { ok: true, issued: true, seatNo: final.seatNo, order: final };
    }

    var rank = waitingOrdersOfTrain(trainCode)
      .findIndex(function (o) { return o.id === newOrder.id; }) + 1;
    pushEvent('waitlisted', '进入候补（第 ' + rank + ' 位）', trainCode, newOrder.id);
    return { ok: true, issued: false, position: rank, order: final };
  }

  /**
   * 退票 / 取消候补：
   * - issued：释放座位区间，删除订单，随后自动按时间戳补录；
   * - waiting：取消候补，出队。
   * 返回 { ok, fulfilled?: n }
   */
  function refundOrder(orderId) {
    var order = getOrders().find(function (o) { return o.id === orderId; });
    if (!order) return { ok: false, msg: '订单不存在' };

    var wasIssued = order.status === 'issued';
    var q = getQueues();
    dequeueOrder(q, order);
    saveQueues(q);

    var res = Domain.removeOrder(orderId);
    if (!res.ok) return res;
    pushEvent('refund', wasIssued ? '退票：座位 ' + order.seatNo + ' 释放' : '取消候补', order.trainCode, orderId);

    // 释放区间后立即按时间戳补录
    var train = Domain.getTrain(order.trainCode);
    var fulfilled = 0;
    if (train) {
      var r = processTrainWaiting(train);
      fulfilled = r.issued.length;
    }
    return { ok: true, fulfilled: fulfilled };
  }

  /* ================= 启动对账 ================= */

  /**
   * 队列与 orders 对账（幂等）：
   * - 旧版 buckets 结构或已不存在车次的队列：废弃重建；
   * - 队列内悬空条目（订单已删/已出票）移除、缺失候补按 createdAt 补入；
   * - 随后对每个有候补的车次做一次补录扫描。
   */
  function scanAllTrains() {
    var orders = getOrders();
    var waitingByTrain = {};
    var waitingIds = {};
    orders.forEach(function (o) {
      if (o.status !== 'waiting') return;
      (waitingByTrain[o.trainCode] = waitingByTrain[o.trainCode] || []).push(o);
      waitingIds[o.id] = true;
    });

    var q = getQueues();
    var qChanged = false;

    Object.keys(q.trains).forEach(function (code) {
      var queue = q.trains[code];
      var legacy = queue && !Array.isArray(queue) && queue.buckets;
      if (legacy || (!Domain.getTrain(code) && !waitingByTrain[code])) {
        delete q.trains[code];
        qChanged = true;
      }
    });

    Object.keys(q.trains).forEach(function (code) {
      var queue = q.trains[code];
      for (var i = queue.length - 1; i >= 0; i--) {
        if (!waitingIds[queue[i].id]) {
          queue.splice(i, 1);
          qChanged = true;
        }
      }
    });

    Object.keys(waitingByTrain).forEach(function (code) {
      if (!Domain.getTrain(code)) return;
      waitingByTrain[code].forEach(function (o) {
        var queue = getQueue(q, code);
        var exists = queue.some(function (e) { return e.id === o.id; });
        if (!exists) {
          var lo = 0, hi = queue.length;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (queue[mid].createdAt < o.createdAt) lo = mid + 1;
            else hi = mid;
          }
          queue.splice(lo, 0, { id: o.id, fromIdx: o.fromIdx, toIdx: o.toIdx, createdAt: o.createdAt });
          qChanged = true;
        }
      });
    });

    if (qChanged) saveQueues(q);

    var fulfilled = processAllWaiting();
    return { fulfilled: fulfilled };
  }

  /* ================= 导出 ================= */

  global.Ticketing = {
    beginBatch: beginBatch,
    endBatch: endBatch,
    purchase: purchase,
    refundOrder: refundOrder,
    processTrainWaiting: processTrainWaiting,
    processAllWaiting: processAllWaiting,
    scanAllTrains: scanAllTrains,
    ordersOfTrain: ordersOfTrain,
    waitingOrdersOfTrain: waitingOrdersOfTrain,
    allWaitingOrders: allWaitingOrders,
    capacitySummary: capacitySummary,
    segmentLoad: segmentLoad,
    Events: {
      push: pushEvent,
      list: listEvents,
      TYPES: EVENT_TYPES
    }
  };
})(window);
