/* 仿真引擎：基于一条线路自动生成三类车次（直达车/大站快车/隔站停车）、
   批量购票请求复用 Ticketing.purchase（逐单区间适配出票）跑完整流程，并汇总统计。
   纯逻辑无 DOM；所有仿真实体带 sim: true 标记，便于一键清理。 */
(function (global) {
  'use strict';

  var Domain = global.Domain, Ticketing = global.Ticketing;

  /* ---------- 可复现随机数（mulberry32） ---------- */

  function makeRng(seed) {
    var a = (Number(seed) || 0) >>> 0;
    if (!a) a = 0x9E3779B9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, min, max) { // [min, max]
    return min + Math.floor(rng() * (max - min + 1));
  }



  /* ---------- 四类车次生成（均挂接线路，站序为线路子序列） ---------- */

  var TYPE_DIRECT = 'direct', TYPE_EXPRESS = 'express', TYPE_SKIP = 'skip';

  function typeOfTrain(train) {
    if (train.simType) return train.simType;
    return '';
  }

  function pickStops(rng, line, type) {
    var seq = line.stationSeq, majors = line.majorNos || [];
    var n = seq.length;
    var stops = [];
    if (type === TYPE_DIRECT) {
      // 两点直达：仅在大站之间开行（两端均为大站），中间不停靠
      if (majors.length < 2) return null;
      var mi = randInt(rng, 0, majors.length - 2);
      var mj = randInt(rng, mi + 1, majors.length - 1);
      stops = [majors[mi], majors[mj]];
    } else if (type === TYPE_EXPRESS) {
      // 大站快车：随机取两个大站作为始发/终到（不一定线路首末），只停靠区间内大站
      if (majors.length < 2) return null;
      var mi2 = randInt(rng, 0, majors.length - 2);
      var mj2 = randInt(rng, mi2 + 1, majors.length - 1);
      stops = majors.slice(mi2, mj2 + 1);
    } else if (type === TYPE_SKIP) {
      // 隔站停车：随机起终点（不限线路首末），以隔 1~3 站推进，
      // 途经大站必停（大站优先于随机间隔），终点必停
      var start = randInt(rng, 0, n - 2);
      var end = randInt(rng, start + 1, n - 1);
      var cur = start;
      stops.push(seq[cur]);
      while (cur < end) {
        var gapNext = cur + 1 + randInt(rng, 1, 3);
        var nextMajor = -1;
        for (var m = cur + 1; m < end; m++) {
          if (majors.indexOf(seq[m]) !== -1) { nextMajor = m; break; }
        }
        var next = Math.min(gapNext, end);
        if (nextMajor !== -1 && nextMajor < next) next = nextMajor;
        stops.push(seq[next]);
        cur = next;
      }
    }
    return stops;
  }

  /** 各类型车次字头：直达车与大站快车 G、隔站停车 D */
  var TYPE_PREFIX = { direct: 'G', express: 'G', skip: 'D' };

  var TYPE_META = {
    direct: { label: '直达车', badge: 'badge-type-direct' },
    express: { label: '大站快车', badge: 'badge-type-express' },
    skip: { label: '隔站停车', badge: 'badge-type-skip' }
  };

  function generateTrains(line, cfg, rng) {
    var plan = [
      [TYPE_DIRECT, cfg.countDirect],
      [TYPE_EXPRESS, cfg.countExpress],
      [TYPE_SKIP, cfg.countSkip]
    ];
    var created = [];
    plan.forEach(function (item) {
      var type = item[0], count = Math.max(0, Math.floor(Number(item[1]) || 0));
      for (var i = 0; i < count; i++) {
        var stops = pickStops(rng, line, type);
        if (!stops || stops.length < 2) continue;
        var res = Domain.addTrain(stops, cfg.seats, line.id, TYPE_PREFIX[type]);
        if (!res.ok) continue;
        // 为仿真车次补充类型标记（直接改写并持久化）
        var trains = Domain.listTrains();
        var t = trains.find(function (x) { return x.code === res.train.code; });
        if (t) {
          t.simType = type;
          t.sim = true;
          global.Storage.write(global.Storage.KEYS.trains, trains);
        }
        created.push(t || res.train);
      }
    });
    return created;
  }

  /* ---------- 仿真主流程 ---------- */

  /**
   * cfg = { lineId 或 autoStationCount, countDirect, countExpress, countSkip,
   *         seats, requests, seed }
   * 返回 { ok, msg?, summary }
   */
  function runSimulation(cfg) {
    // 运算耗时计时起点（performance.now 不可用时回退 Date.now，保证 file:// 直开可靠）
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // 种子：-1（或未填）表示随机种子，其余值结果可复现
    var seedVal = Number(cfg.seed);
    var seed = (cfg.seed === '' || cfg.seed === undefined || cfg.seed === null || !isFinite(seedVal) || seedVal < 0)
      ? Math.floor(Math.random() * 2147483647)
      : Math.floor(seedVal);

    // 1. 线路：选择已有线路，或自动生成一条 sim 线路
    var line;
    if (cfg.lineId === '__auto__') {
      var stationCount = Math.max(4, Math.min(30, Math.floor(Number(cfg.autoStationCount) || 10)));
      var seq = [];
      for (var s = 0; s < stationCount; s++) {
        var res = Domain.addStation('模拟站' + (s + 1) + '-' + seed, 'Sim' + (s + 1));
        if (!res.ok) return { ok: false, msg: '生成模拟车站失败：' + res.msg };
        seq.push(res.station.no);
      }
      // 回写 sim 标记
      var stations = Domain.listStations();
      stations.forEach(function (st) { if (st.nameEn.indexOf('Sim') === 0) st.sim = true; });
      global.Storage.write(global.Storage.KEYS.stations, stations);
      var lineRes = Domain.addLine('模拟线路-' + seed, seq, null, { sim: true });
      if (!lineRes.ok) return { ok: false, msg: '生成模拟线路失败：' + lineRes.msg };
      line = lineRes.line;
    } else {
      line = Domain.getLine(cfg.lineId);
      if (!line) return { ok: false, msg: '请选择仿真线路' };
    }

    var rng = makeRng(seed);

    // 批量事务：批次内 orders/queues/events 全部走内存缓存，结束时一次性落盘
    Ticketing.beginBatch();
    try {

    // 2. 生成车次
    var trains = generateTrains(line, cfg, rng);
    if (!trains.length) return { ok: false, msg: '未能生成任何车次，请检查各类车次数参数' };

    // 3. 编排购票请求：每车次 requests 条，随机合法区间
    var reqCount = Math.max(1, Math.floor(Number(cfg.requests) || 10));
    var events = [];
    var simOrderIds = {};
    var perTrain = {};
    trains.forEach(function (t) {
      perTrain[t.code] = { train: t, requests: 0, issued: 0, waiting: 0 };
    });

    trains.forEach(function (t) {
      var n = t.stationSeq.length;
      for (var r = 0; r < reqCount; r++) {
        var fromIdx = randInt(rng, 0, n - 2);
        var toIdx = randInt(rng, fromIdx + 1, n - 1);
        var res = Ticketing.purchase(t.code, fromIdx, toIdx);
        var stat = perTrain[t.code];
        stat.requests++;
        if (res.ok && res.issued) stat.issued++;
        else if (res.ok) stat.waiting++;
        if (res.ok && res.order) simOrderIds[res.order.id] = true;
        events.push({
          trainCode: t.code,
          fromIdx: fromIdx, toIdx: toIdx,
          issued: !!(res.ok && res.issued), seatNo: res.seatNo, position: res.position
        });
      }
    });

    } finally {
      Ticketing.endBatch();
    }

    // 批次落盘后，为本次仿真的订单统一打 sim 标记（一次写回）
    var orderList = Domain.listOrders();
    var marked = false;
    orderList.forEach(function (o) { if (simOrderIds[o.id]) { o.sim = true; marked = true; } });
    if (marked) global.Storage.write(global.Storage.KEYS.orders, orderList);

    // 4. 汇总
    var totalRequests = 0, totalIssued = 0, totalWaiting = 0;
    Object.keys(perTrain).forEach(function (code) {
      totalRequests += perTrain[code].requests;
      totalIssued += perTrain[code].issued;
      totalWaiting += perTrain[code].waiting;
    });

    return {
      ok: true,
      summary: {
        line: line,
        trains: trains,
        perTrain: perTrain,
        events: events,
        totalRequests: totalRequests,
        totalIssued: totalIssued,
        totalWaiting: totalWaiting,
        issuedRate: totalRequests ? (totalIssued / totalRequests * 100) : 0,
        usedSeed: seed,
        elapsedMs: Math.max(0, Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0))
      }
    };
  }

  /* ---------- 清理：按 sim 标记精准回收 ---------- */

  function cleanupSimulation() {
    var Storage = global.Storage;
    // 1) 删 sim 订单
    var orders = Domain.listOrders().filter(function (o) { return !o.sim; });
    Storage.write(Storage.KEYS.orders, orders);
    // 2) 删 sim 车次（此时已无订单引用）
    var trains = Domain.listTrains().filter(function (t) { return !t.sim; });
    Storage.write(Storage.KEYS.trains, trains);
    // 3) 删 sim 线路（此时已无车次挂接）与 sim 车站（站序无引用）
    var lines = Domain.listLines().filter(function (l) { return !l.sim; });
    Storage.write(Storage.KEYS.lines, lines);
    var removedNos = {};
    Domain.listStations().forEach(function (st) {
      if (st.sim) removedNos[st.no] = true;
    });
    var stations = Domain.listStations().filter(function (st) { return !st.sim; });
    Storage.write(Storage.KEYS.stations, stations);
    // 号码池回收重建
    Domain.rebuildSeqPools();
    return { stations: Object.keys(removedNos).length };
  }

  global.Simulation = {
    runSimulation: runSimulation,
    cleanupSimulation: cleanupSimulation,
    TYPE_META: TYPE_META,
    TYPE_PREFIX: TYPE_PREFIX,
    typeOfTrain: typeOfTrain,
    makeRng: makeRng
  };
})(window);
