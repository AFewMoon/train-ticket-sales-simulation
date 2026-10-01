/* 出票算法层：
   —— 洞察：一组候补订单「严格首尾相接且恰好覆盖 [0, 末站]」等价于在以订单区间为边、
      站序下标为节点的 DAG 上存在一条 0 → 末站 的路径。
   —— 每次购票请求到达时重建邻接桶并 BFS，找到路径即整组出票并分配座位；
      用差分/前缀和统计座位分段占用，供剩余运力与座位图渲染。 */
(function (global) {
  'use strict';

  var K = global.Storage.KEYS;
  var Domain = global.Domain;

  function persistOrders(orders) {
    return global.Storage.write(K.orders, orders);
  }

  /* ---------- 查询 ---------- */

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

  /* ---------- 差分/前缀和：座位分段占用 ---------- */

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

  /** 车次剩余运力摘要：全程未覆盖的相邻区间数 / 总区间数 */
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

  /* ---------- DAG-BFS 出票核心 ---------- */

  /**
   * 在候补订单集合中寻找一条 0 → (S-1) 的路径。
   * ordersByFrom[i] 为 fromIdx === i 的订单桶；命中路径后用 order._used 标记删除。
   * 返回路径订单数组（按站序排列），找不到返回 null。
   */
  function findCoverPath(waitingOrders, stationCount) {
    var ordersByFrom = [];
    for (var i = 0; i < stationCount; i++) ordersByFrom.push([]);
    waitingOrders.forEach(function (o) {
      if (o._used) return;
      if (o.fromIdx >= 0 && o.toIdx < stationCount && o.fromIdx < o.toIdx) {
        ordersByFrom[o.fromIdx].push(o);
      }
    });

    var prevStation = new Array(stationCount).fill(-1);
    var prevOrder = new Array(stationCount).fill(null);
    var visited = new Array(stationCount).fill(false);
    visited[0] = true;

    var queue = [0], head = 0;
    while (head < queue.length) {
      var u = queue[head++];
      for (var j = 0; j < ordersByFrom[u].length; j++) {
        var o = ordersByFrom[u][j];
        if (o._used) continue;
        var v = o.toIdx;
        if (visited[v]) continue;
        visited[v] = true;
        prevStation[v] = u;
        prevOrder[v] = o;
        if (v === stationCount - 1) {
          // 还原路径
          var path = [], cur = v;
          while (cur !== 0) {
            path.unshift(prevOrder[cur]);
            cur = prevStation[cur];
          }
          return path;
        }
        queue.push(v);
      }
    }
    return null;
  }

  /** 为一组订单分配一个空闲座位：该座位当前未被任何已出票票段占用（此时必然全程空闲，
      因为出票座位上的票恰好全程相接覆盖，任何后续路径无法与已覆盖座位共存于同一组合） */
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

  /**
   * 购票：创建订单并触发一次完整出票扫描。
   * 返回 { ok, message, order }
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

    var result = runTicketingScan(train, orders);

    if (!persistOrders(orders)) {
      return { ok: false, msg: '保存订单失败' };
    }

    // 判定新订单的最终状态
    var final = orders.find(function (o) { return o.id === newOrder.id; });
    if (final.status === 'issued') {
      return { ok: true, issued: true, seatNo: final.seatNo, order: final, issuedGroup: result.issuedGroups.flat() };
    }
    var waitingCount = orders.filter(function (o) {
      return o.trainCode === trainCode && o.status === 'waiting';
    }).length;
    // 候补位置：按创建时间排序后的名次
    var rank = orders.filter(function (o) {
      return o.trainCode === trainCode && o.status === 'waiting';
    }).sort(function (a, b) { return a.createdAt - b.createdAt; })
      .findIndex(function (o) { return o.id === newOrder.id; }) + 1;
    return { ok: true, issued: false, position: rank, waitingCount: waitingCount, order: final };
  }

  /**
   * 对某车次执行一次出票扫描：
   * 重复 BFS 寻找 0→末站 路径并整组出票（分配座位），直到找不到路径或座位用尽。
   * 返回本次出票的组列表。
   */
  function runTicketingScan(train, orders) {
    var trainOrders = orders.filter(function (o) { return o.trainCode === train.code; });
    var issued = trainOrders.filter(function (o) { return o.status === 'issued'; });
    var waiting = trainOrders.filter(function (o) { return o.status === 'waiting'; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });

    var issuedGroups = [];
    var guard = 0;
    while (guard++ < 1000) {
      var path = findCoverPath(waiting, train.stationSeq.length);
      if (!path || path.length === 0) break;

      var seatNo = allocateSeat(train, issued, path);
      if (seatNo === null) break; // 座位用尽

      path.forEach(function (o) {
        o.status = 'issued';
        o.seatNo = seatNo;
        o._used = true;
        issued.push(o);
      });
      issuedGroups.push(path);
      waiting = waiting.filter(function (o) { return !o._used; });
    }

    // 清理标记
    orders.forEach(function (o) { delete o._used; });
    return { issuedGroups: issuedGroups };
  }

  /** 全局扫描：对每个有候补订单的车次各执行一次出票扫描（数据修复用） */
  function scanAllTrains() {
    var orders = Domain.listOrders();
    var trains = Domain.listTrains();
    var changed = false;
    trains.forEach(function (t) {
      var hasWaiting = orders.some(function (o) { return o.trainCode === t.code && o.status === 'waiting'; });
      if (hasWaiting) {
        runTicketingScan(t, orders);
        changed = true;
      }
    });
    if (changed) persistOrders(orders);
    return orders;
  }

  /* ---------- 导出 ---------- */

  global.Ticketing = {
    purchase: purchase,
    runTicketingScan: runTicketingScan,
    scanAllTrains: scanAllTrains,
    ordersOfTrain: ordersOfTrain,
    waitingOrdersOfTrain: waitingOrdersOfTrain,
    allWaitingOrders: allWaitingOrders,
    capacitySummary: capacitySummary,
    segmentLoad: segmentLoad
  };
})(window);
