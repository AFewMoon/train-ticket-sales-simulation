/* 出票算法层（逐单区间适配 · 在线版）：
   —— 规则：候补订单按 createdAt 升序逐单尝试补录，任一座位的目标区间
      [fromIdx, toIdx) 完全空闲即出票到该座位——允许座位存在空洞，最大化座位利用率。
   —— 在线机制：候补队列按车次持久化（tts:queues，单条时戳有序列表），
      入队 O(log W)、出票 O(1) 移除；退票后自动按时间戳补录。
   —— 事件流：购票/出票/候补/退票/兑现/自动扫描写入 tts:events（上限 500）。 */
(function (global) {
  'use strict';

  var K = global.Storage.KEYS;
  var Domain = global.Domain;

  var EVENTS_CAP = 500;

  function persistOrders(orders) {
    return global.Storage.write(K.orders, orders);
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
    var events = global.Storage.read(K.events, []);
    events.push({
      id: Domain.uid('e'),
      ts: Date.now(),
      type: type,
      trainCode: trainCode || '',
      orderId: orderId || '',
      detail: detail
    });
    if (events.length > EVENTS_CAP) events = events.slice(events.length - EVENTS_CAP);
    global.Storage.write(K.events, events);
  }

  function listEvents(limit) {
    var events = global.Storage.read(K.events, []);
    return events.slice(-limit).reverse();
  }

  /* ================= 候补队列（在线持久化，时戳有序） ================= */

  function readQueues() {
    return global.Storage.read(K.queues, { trains: {} });
  }

  function writeQueues(q) {
    return global.Storage.write(K.queues, q);
  }

  /** 取某车次的候补队列（数组，按 createdAt 升序） */
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
    return Domain.listOrders().filter(function (o) { return o.trainCode === trainCode; });
  }

  function waitingOrdersOfTrain(trainCode) {
    return ordersOfTrain(trainCode)
      .filter(function (o) { return o.status === 'waiting'; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  function allWaitingOrders() {
    return Domain.listOrders().filter(function (o) { return o.status === 'waiting'; });
  }

  /* ================= 差分/前缀和：座位分段占用 ================= */

  /** 统计某座位已出票订单在各相邻区间的覆盖张数。返回长度 S-1 的数组 */
  function segmentLoad(issuedOrders, stationCount, seatNo) {
    var diff = new Array(stationCount).fill(0);
    issuedOrders.forEach(function (o) {
      if (o.seatNo !== seatNo) return;
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

  /** 车次剩余运力摘要 */
  function capacitySummary(train, orders) {
    var stationCount = train.stationSeq.length;
    var issued = orders.filter(function (o) { return o.status === 'issued'; });
    var freeSegments = 0, totalSegments = stationCount - 1;
    var perSeat = [];
    for (var s = 1; s <= train.seatCount; s++) {
      var load = segmentLoad(issued, stationCount, s);
      var free = load.filter(function (x) { return x === 0; }).length;
      perSeat.push({ seatNo: s, freeSegments: free });
      freeSegments += free;
    }
    return { totalSegments: totalSegments, freeSegments: freeSegments, perSeat: perSeat };
  }

  /* ================= 逐单区间适配 ================= */

  /** 为单张订单寻找座位：目标区间 [fromIdx, toIdx) 在该座位上完全空闲即出票 */
  function allocateSeatForOrder(train, issuedOrders, order) {
    var stationCount = train.stationSeq.length;
    for (var s = 1; s <= train.seatCount; s++) {
      var load = segmentLoad(issuedOrders, stationCount, s);
      var free = true;
      for (var i = order.fromIdx; i < order.toIdx; i++) {
        if (load[i] > 0) { free = false; break; }
      }
      if (free) return s;
    }
    return null;
  }

  /**
   * 对某车次执行候补补录扫描：按队列时戳升序逐单尝试区间适配，
   * 出票即出队并进入下一单（后续订单仍继续尝试，最大化利用率）。
   * 返回 { issued: [order...], changed: bool }
   */
  function processTrainWaiting(train) {
    var orders = Domain.listOrders();
    var orderById = {};
    orders.forEach(function (o) { orderById[o.id] = o; });
    var issued = orders.filter(function (o) { return o.trainCode === train.code && o.status === 'issued'; });

    var q = readQueues();
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
      persistOrders(orders);
      writeQueues(q);
    }
    return { issued: result, changed: changed };
  }

  /** 遍历全部有候补的车次执行补录扫描（供定时器/全局入口调用），返回兑现总单数 */
  function processAllWaiting() {
    var q = readQueues();
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
  function purchase(trainCode, passengerId, fromIdx, toIdx) {
    var train = Domain.getTrain(trainCode);
    if (!train) return { ok: false, msg: '车次不存在' };
    var passenger = Domain.getPassenger(passengerId);
    if (!passenger) return { ok: false, msg: '乘车人不存在' };
    if (!Domain.isValidRange(fromIdx, toIdx)) return { ok: false, msg: '非法区间' };
    if (toIdx >= train.stationSeq.length) return { ok: false, msg: '区间超出车次站序' };

    var orders = Domain.listOrders();
    var newOrder = {
      id: Domain.uid('o'),
      trainCode: trainCode,
      passengerId: passengerId,
      fromIdx: fromIdx,
      toIdx: toIdx,
      status: 'waiting',
      createdAt: Date.now() + (orders.length % 1000) * 0.001 // 保证同毫秒下排序稳定
    };
    orders.push(newOrder);
    if (!persistOrders(orders)) return { ok: false, msg: '保存订单失败' };

    // 在线入队 + 补录扫描
    var q = readQueues();
    enqueueOrder(q, newOrder);
    writeQueues(q);
    pushEvent('purchase', '购票请求：' + trainCode + ' ' + fromIdx + '→' + toIdx, trainCode, newOrder.id);

    processTrainWaiting(train);
    var final = Domain.listOrders().find(function (o) { return o.id === newOrder.id; });

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
    var order = Domain.listOrders().find(function (o) { return o.id === orderId; });
    if (!order) return { ok: false, msg: '订单不存在' };

    var wasIssued = order.status === 'issued';
    var q = readQueues();
    dequeueOrder(q, order);
    writeQueues(q);

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
   * - 队列结构与订单集合 diff：悬空条目移除、缺失候补按 createdAt 补入；
   * - 随后对每个有候补的车次做一次补录扫描。
   */
  function scanAllTrains() {
    var orders = Domain.listOrders();
    var waitingByTrain = {};
    var waitingIds = {};
    orders.forEach(function (o) {
      if (o.status !== 'waiting') return;
      (waitingByTrain[o.trainCode] = waitingByTrain[o.trainCode] || []).push(o);
      waitingIds[o.id] = true;
    });

    var q = readQueues();
    var qChanged = false;

    // 旧版结构（buckets）或已不存在车次的队列：整体废弃重建
    Object.keys(q.trains).forEach(function (code) {
      var queue = q.trains[code];
      var legacy = queue && !Array.isArray(queue) && queue.buckets;
      if (legacy || (!Domain.getTrain(code) && !waitingByTrain[code])) {
        delete q.trains[code];
        qChanged = true;
      }
    });

    // 清理悬空条目
    Object.keys(q.trains).forEach(function (code) {
      var queue = q.trains[code];
      for (var i = queue.length - 1; i >= 0; i--) {
        if (!waitingIds[queue[i].id]) {
          queue.splice(i, 1);
          qChanged = true;
        }
      }
    });

    // 补入缺失的 waiting 订单（保持 createdAt 升序）
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

    if (qChanged) writeQueues(q);

    // 对每个有候补的车次做一次补录扫描（数据修复）
    var fulfilled = processAllWaiting();
    return { fulfilled: fulfilled };
  }

  /* ================= 导出 ================= */

  global.Ticketing = {
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
