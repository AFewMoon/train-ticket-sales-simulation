/* 出票算法层（在线增量版）：
   —— 洞察：一组候补订单「严格首尾相接且恰好覆盖 [0, 末站]」等价于在以订单区间为边、
      站序下标为节点的 DAG 上存在一条 0 → 末站 的路径。
   —— 在线算法：候补邻接桶按车次持久化（tts:queues），新订单 O(log W) 有序入队、
      出票组 O(组大小) 移除，购票时不再全量重建候补集合；BFS 沿桶按时戳升序遍历，
      路径优先选用更早的候补订单。
   —— 事件流：购票/出票/候补/退票/兑现写入 tts:events（容量上限 FIFO 淘汰）。 */
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
    fulfilled: { label: '兑现', cls: 'ev-fulfilled' },
    autoscan: { label: '自动扫描', cls: 'ev-autoscan' }
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

  /* ================= 候补邻接桶（在线持久化） ================= */

  function readQueues() {
    return global.Storage.read(K.queues, { trains: {} });
  }

  function writeQueues(q) {
    return global.Storage.write(K.queues, q);
  }

  function getTrainQueue(q, trainCode, stationCount) {
    if (!q.trains[trainCode]) {
      q.trains[trainCode] = { buckets: [] };
      for (var i = 0; i < stationCount; i++) q.trains[trainCode].buckets.push([]);
    }
    var tq = q.trains[trainCode];
    while (tq.buckets.length < stationCount) tq.buckets.push([]);
    return tq;
  }

  /** 按 createdAt 升序二分查找插入位置 */
  function lowerBound(bucket, createdAt) {
    var lo = 0, hi = bucket.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (bucket[mid].createdAt < createdAt) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 新候补订单入队：O(log W) 定位 + 插入 */
  function enqueueOrder(q, order, stationCount) {
    var tq = getTrainQueue(q, order.trainCode, stationCount);
    var bucket = tq.buckets[order.fromIdx];
    var entry = { id: order.id, fromIdx: order.fromIdx, toIdx: order.toIdx, createdAt: order.createdAt };
    bucket.splice(lowerBound(bucket, order.createdAt), 0, entry);
    return entry;
  }

  /** 出队（出票/取消）：按 id 从桶中移除 */
  function dequeueOrder(q, order) {
    var tq = q.trains[order.trainCode];
    if (!tq) return;
    var bucket = tq.buckets[order.fromIdx];
    if (!bucket) return;
    var idx = bucket.findIndex(function (e) { return e.id === order.id; });
    if (idx !== -1) bucket.splice(idx, 1);
  }

  /** 从桶中移除一组已出票订单 */
  function dequeueGroup(q, group) {
    group.forEach(function (o) { dequeueOrder(q, o); });
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

  /* ================= DAG-BFS（时戳引导） ================= */

  /**
   * 在持久化候补桶中寻找一条 0 → (S-1) 的路径。
   * 每个桶已按 createdAt 升序排列，BFS 按桶序遍历 → 路径优先选用更早的候补订单。
   * entries: fromIdx → [{id, fromIdx, toIdx, createdAt}...]；usedIds 排除已出票订单。
   */
  function findCoverPath(buckets, stationCount, usedIds) {
    var prevStation = new Array(stationCount).fill(-1);
    var prevEntry = new Array(stationCount).fill(null);
    var visited = new Array(stationCount).fill(false);
    visited[0] = true;

    var queue = [0], head = 0;
    while (head < queue.length) {
      var u = queue[head++];
      var bucket = buckets[u] || [];
      for (var j = 0; j < bucket.length; j++) {
        var e = bucket[j];
        if (usedIds[e.id]) continue;
        var v = e.toIdx;
        if (v >= stationCount || visited[v]) continue;
        visited[v] = true;
        prevStation[v] = u;
        prevEntry[v] = e;
        if (v === stationCount - 1) {
          var path = [], cur = v;
          while (cur !== 0) {
            path.unshift(prevEntry[cur]);
            cur = prevStation[cur];
          }
          return path;
        }
        queue.push(v);
      }
    }
    return null;
  }

  /** 为一组订单分配一个空闲座位（差分探测，逻辑不变） */
  function allocateSeat(train, issuedOrders, group) {
    var stationCount = train.stationSeq.length;
    for (var s = 1; s <= train.seatCount; s++) {
      var load = segmentLoad(issuedOrders, stationCount, s);
      var hasConflict = group.some(function (o) {
        for (var i = o.fromIdx; i < o.toIdx; i++) if (load[i] > 0) return true;
        return false;
      });
      if (!hasConflict) return s;
    }
    return null;
  }

  /* ================= 在线处理：单 train 扫描 ================= */

  /**
   * 对某车次执行候补兑现扫描：直接在持久桶上重复 BFS，直到无新路径或座位用尽。
   * 返回 { groups: [[order...]], changed: bool }。
   */
  function processTrainWaiting(train) {
    var orders = Domain.listOrders();
    var issued = orders.filter(function (o) { return o.trainCode === train.code && o.status === 'issued'; });
    var orderById = {};
    orders.forEach(function (o) { orderById[o.id] = o; });

    var q = readQueues();
    var tq = getTrainQueue(q, train.code, train.stationSeq.length);
    var buckets = tq.buckets;

    var groups = [];
    var guard = 0;
    var changed = false;
    while (guard++ < 1000) {
      var usedIds = {};
      groups.forEach(function (g) {
        g.forEach(function (o) { usedIds[o.id] = true; });
      });
      var path = findCoverPath(buckets, train.stationSeq.length, usedIds);
      if (!path || path.length === 0) break;

      // 路径条目 → 实际订单
      var group = path.map(function (e) { return orderById[e.id]; });
      if (group.some(function (o) { return !o; })) {
        // 桶内存在悬空条目（对账兜底）：清除后重试
        path.forEach(function (e) {
          for (var b = 0; b < buckets.length; b++) {
            var bi = buckets[b].findIndex(function (x) { return x.id === e.id; });
            if (bi !== -1) { buckets[b].splice(bi, 1); changed = true; }
          }
        });
        continue;
      }

      var seatNo = allocateSeat(train, issued, group);
      if (seatNo === null) break; // 座位用尽

      group.forEach(function (o) {
        o.status = 'issued';
        o.seatNo = seatNo;
        issued.push(o);
      });
      dequeueGroup(q, group);
      groups.push(group);
      changed = true;
      pushEvent('fulfilled', '候补兑现：' + group.length + ' 单拼成全程覆盖，分配座位 ' + seatNo, train.code, group[0].id);
    }

    if (changed) {
      persistOrders(orders);
      writeQueues(q);
    }
    return { groups: groups, changed: changed };
  }

  /** 遍历全部有候补的车次执行扫描（供定时器/全局入口调用），返回兑现总单数 */
  function processAllWaiting() {
    var q = readQueues();
    var fulfilled = 0;
    Domain.listTrains().forEach(function (t) {
      var tq = q.trains[t.code];
      var hasWaiting = tq && tq.buckets.some(function (b) { return b.length > 0; });
      if (hasWaiting) {
        var res = processTrainWaiting(t);
        res.groups.forEach(function (g) { fulfilled += g.length; });
      }
    });
    return fulfilled;
  }

  /* ================= 购票 / 退票 ================= */

  /**
   * 购票：创建订单 → O(log W) 入队 → 仅对该车次做候补兑现扫描。
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

    // 在线入队 + 兑现扫描
    var q = readQueues();
    enqueueOrder(q, newOrder, train.stationSeq.length);
    writeQueues(q);
    pushEvent('purchase', '购票请求：' + trainCode + ' ' + fromIdx + '→' + toIdx, trainCode, newOrder.id);

    var res = processTrainWaiting(train);
    var final = Domain.listOrders().find(function (o) { return o.id === newOrder.id; });

    if (final && final.status === 'issued') {
      pushEvent('issued', '出票成功：座位 ' + final.seatNo, trainCode, newOrder.id);
      return { ok: true, issued: true, seatNo: final.seatNo, order: final };
    }

    // 候补名次：该车次候补按 createdAt 升序中的位置
    var rank = waitingOrdersOfTrain(trainCode)
      .findIndex(function (o) { return o.id === newOrder.id; }) + 1;
    pushEvent('waitlisted', '进入候补（第 ' + rank + ' 位）', trainCode, newOrder.id);
    return { ok: true, issued: false, position: rank, order: final };
  }

  /**
   * 退票 / 取消候补：
   * - issued：释放座位区间，删除订单，随后自动扫描该车次候补填补空缺；
   * - waiting：取消候补，从持久桶移除。
   * 返回 { ok, fulfilled?: n }
   */
  function refundOrder(orderId) {
    var orders = Domain.listOrders();
    var order = orders.find(function (o) { return o.id === orderId; });
    if (!order) return { ok: false, msg: '订单不存在' };

    var wasIssued = order.status === 'issued';
    // 从持久桶移除（无论状态，幂等）
    var q = readQueues();
    dequeueOrder(q, order);
    writeQueues(q);

    var res = Domain.removeOrder(orderId);
    if (!res.ok) return res;
    pushEvent('refund', wasIssued ? '退票：座位 ' + order.seatNo + ' 释放' : '取消候补', order.trainCode, orderId);

    // 释放座位后立即尝试候补兑现
    var train = Domain.getTrain(order.trainCode);
    var fulfilled = 0;
    if (train) {
      var r = processTrainWaiting(train);
      r.groups.forEach(function (g) { fulfilled += g.length; });
    }
    return { ok: true, fulfilled: fulfilled };
  }

  /* ================= 启动对账 ================= */

  /**
   * 队列与 orders 对账（幂等）：
   * - 桶内悬空条目（订单已不存在/已出票）移除；
   * - 实际 waiting 订单未入桶的补入；
   * - 随后对每个有候补的车次做一次兑现扫描。
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

    // 清理悬空条目与已不存在/已出票的车次桶
    Object.keys(q.trains).forEach(function (code) {
      if (!waitingByTrain[code] && !Domain.getTrain(code)) {
        delete q.trains[code];
        qChanged = true;
        return;
      }
    });
    Object.keys(q.trains).forEach(function (code) {
      var tq = q.trains[code];
      tq.buckets.forEach(function (bucket, fi) {
        for (var i = bucket.length - 1; i >= 0; i--) {
          if (!waitingIds[bucket[i].id]) {
            bucket.splice(i, 1);
            qChanged = true;
          }
        }
      });
    });

    // 补入缺失的 waiting 订单
    Object.keys(waitingByTrain).forEach(function (code) {
      var train = Domain.getTrain(code);
      if (!train) return;
      var stationCount = train.stationSeq.length;
      waitingByTrain[code].forEach(function (o) {
        var tq = getTrainQueue(q, code, stationCount);
        var bucket = tq.buckets[o.fromIdx];
        if (!bucket) { qChanged = true; return; }
        var exists = bucket.some(function (e) { return e.id === o.id; });
        if (!exists) {
          bucket.splice(lowerBound(bucket, o.createdAt), 0,
            { id: o.id, fromIdx: o.fromIdx, toIdx: o.toIdx, createdAt: o.createdAt });
          qChanged = true;
        }
      });
    });

    if (qChanged) writeQueues(q);

    // 对每个有候补的车次做一次兑现扫描（数据修复）
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
