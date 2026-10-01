/* 领域层：车站 / 线路 / 车次的增删查、唯一号码与车次号生成、区间与子序列校验。
   不操作 DOM，所有数据经 Storage 层持久化。 */
(function (global) {
  'use strict';

  var K = global.Storage.KEYS;

  /* ---------- 工具 ---------- */

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad3(n) { return String(n).padStart(3, '0'); }

  /* ---------- 数据读取 ---------- */

  function listStations() { return global.Storage.read(K.stations, []); }
  function listTrains() { return global.Storage.read(K.trains, []); }
  function listOrders() { return global.Storage.read(K.orders, []); }
  function listLines() { return global.Storage.read(K.lines, []); }

  /* ---------- 唯一号码池 ---------- */

  var seq = global.Storage.read(K.seq, { stationNos: [], trainCodes: [] });

  function saveSeq() { global.Storage.write(K.seq, seq); }

  /** 随机取一个未被占用且不在排除集合中的元素；用尽返回 null。
      takenSet 以 pad3 字符串存储（'000'-'999'），查询时必须同格式转换——
      注意 String(i)='5' ≠ '005'，必须用 pad3 */
  function randomPick(total, takenSet) {
    var pool = [];
    for (var i = 0; i < total; i++) if (!takenSet.has(pad3(i))) pool.push(i);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** 随机分配全局唯一 3 位车站号码（000-999） */
  function allocateStationNo() {
    var used = new Set();
    listStations().forEach(function (s) { used.add(s.no); });
    seq.stationNos.forEach(function (n) { used.add(n); });
    var idx = randomPick(1000, used);
    if (idx === null) return null;
    var no = pad3(idx);
    seq.stationNos.push(no);
    saveSeq();
    return no;
  }

  /** 为车站重新分配一个不与现有任何车站/号码池冲突的新号码（数据修复迁移用） */
  function reassignStationNo(station) {
    var no = allocateStationNo();
    if (no === null) return false;
    var oldNo = station.no;
    var stations = listStations();
    var s = stations.find(function (x) { return x.no === oldNo && x.nameZh === station.nameZh; });
    if (!s) return false;
    s.no = no;
    if (!global.Storage.write(K.stations, stations)) return false;
    // 同步所有引用旧号码的站序（车次/线路）
    var trains = listTrains();
    var trainsChanged = false;
    trains.forEach(function (t) {
      t.stationSeq = t.stationSeq.map(function (x) { if (x === oldNo) { trainsChanged = true; return no; } return x; });
    });
    if (trainsChanged) global.Storage.write(K.trains, trains);
    var lines = listLines();
    var linesChanged = false;
    lines.forEach(function (l) {
      l.stationSeq = l.stationSeq.map(function (x) { if (x === oldNo) { linesChanged = true; return no; } return x; });
      l.majorNos = (l.majorNos || []).map(function (x) { if (x === oldNo) { linesChanged = true; return no; } return x; });
    });
    if (linesChanged) global.Storage.write(K.lines, lines);
    return true;
  }

  /**
   * 车次号规则：字头 G/D/K + 严格 4 位数字——
   * 首位 ∈ {1,2,3,6,7,8}，中间两位任意，末位为奇数。
   */
  var CODE_FIRST_DIGITS = ['1', '2', '3', '6', '7', '8'];
  var CODE_LAST_DIGITS = ['1', '3', '5', '7', '9'];
  var CODE_RE = /^[GDK][123678]\d{2}[13579]$/;

  function isValidTrainCode(code) {
    return typeof code === 'string' && CODE_RE.test(code);
  }

  /** 按位值规则生成随机 4 位数字部分 */
  function randomCodeNumber(rng) {
    var first = CODE_FIRST_DIGITS[Math.floor((rng ? rng() : Math.random()) * CODE_FIRST_DIGITS.length)];
    var mid1 = Math.floor((rng ? rng() : Math.random()) * 10);
    var mid2 = Math.floor((rng ? rng() : Math.random()) * 10);
    var last = CODE_LAST_DIGITS[Math.floor((rng ? rng() : Math.random()) * CODE_LAST_DIGITS.length)];
    return first + mid1 + mid2 + last;
  }

  /**
   * 生成唯一车次号：字头 + 4 位数字（首位 1~3/6~8、末位奇数）。
   * prefix 可选（'G' | 'D' | 'K'）：指定时只使用该字头；缺省时随机三选一（手动登记场景）。
   */
  function allocateTrainCode(prefix) {
    var used = new Set();
    listTrains().forEach(function (t) { used.add(t.code); });
    seq.trainCodes.forEach(function (c) { used.add(c); });
    var prefixes = (prefix && /^[GDK]$/.test(prefix)) ? [prefix] : ['G', 'D', 'K'];
    for (var attempt = 0; attempt < 5000; attempt++) {
      var p = prefixes[Math.floor(Math.random() * prefixes.length)];
      var code = p + randomCodeNumber(null);
      if (!used.has(code)) {
        seq.trainCodes.push(code);
        saveSeq();
        return code;
      }
    }
    return null;
  }

  /** 测试场景下重置已用号码池（保留号码池中当前仍在使用中的号码） */
  function rebuildSeqPools() {
    var stations = listStations(), trains = listTrains();
    seq.stationNos = stations.map(function (s) { return s.no; });
    seq.trainCodes = trains.map(function (t) { return t.code; });
    saveSeq();
  }

  /* ---------- 车站 ---------- */

  function addStation(nameZh, nameEn) {
    nameZh = String(nameZh || '').trim();
    nameEn = String(nameEn || '').trim();
    if (!nameZh || !nameEn) return { ok: false, msg: '中文名与英文名均不能为空' };
    var stations = listStations();
    var dup = stations.some(function (s) { return s.nameZh === nameZh; });
    if (dup) return { ok: false, msg: '车站中文名已存在：' + nameZh };
    var no = allocateStationNo();
    if (no === null) return { ok: false, msg: '车站号码已用尽（000-999）' };
    var station = { no: no, nameZh: nameZh, nameEn: nameEn };
    stations.push(station);
    if (!global.Storage.write(K.stations, stations)) return { ok: false, msg: '保存失败' };
    return { ok: true, station: station };
  }

  /** 车站是否被任意车次的站序引用 */
  function stationUsedByTrain(no) {
    return listTrains().some(function (t) { return t.stationSeq.indexOf(no) !== -1; });
  }

  function removeStation(no) {
    var stations = listStations();
    var idx = stations.findIndex(function (s) { return s.no === no; });
    if (idx === -1) return { ok: false, msg: '车站不存在' };
    if (stationUsedByTrain(no)) return { ok: false, msg: '该车站已被车次引用，禁止删除' };
    stations.splice(idx, 1);
    if (!global.Storage.write(K.stations, stations)) return { ok: false, msg: '保存失败' };
    return { ok: true };
  }

  function getStation(no) {
    return listStations().find(function (s) { return s.no === no; }) || null;
  }

  /* ---------- 线路 ---------- */

  /** sub 是否为 full 的子序列（保持相对顺序，可跳过元素） */
  function isSubsequence(sub, full) {
    if (!Array.isArray(sub) || !Array.isArray(full)) return false;
    var j = 0;
    for (var i = 0; i < full.length && j < sub.length; i++) {
      if (full[i] === sub[j]) j++;
    }
    return j === sub.length;
  }

  /**
   * 新增线路：name + 有序站序 + 大站集合 majorNos（⊆ stationSeq）。
   * Line { id, name, stationSeq, majorNos, builtin?, sim? }
   */
  function addLine(name, stationSeq, majorNos, flags) {
    name = String(name || '').trim();
    if (!name) return { ok: false, msg: '线路名称不能为空' };
    if (!Array.isArray(stationSeq) || stationSeq.length < 2) {
      return { ok: false, msg: '线路至少需要 2 个途经车站' };
    }
    var seen = {};
    for (var i = 0; i < stationSeq.length; i++) {
      if (seen[stationSeq[i]]) return { ok: false, msg: '线路站序中存在重复车站' };
      seen[stationSeq[i]] = true;
      if (!getStation(stationSeq[i])) return { ok: false, msg: '站序中包含未登记的车站' };
    }
    var majors = (Array.isArray(majorNos) ? majorNos : []).filter(function (no) {
      return seen[no];
    });
    if (!majors.length) {
      // 未指定大站时默认首末站为大站
      majors = [stationSeq[0], stationSeq[stationSeq.length - 1]];
    }
    var lines = listLines();
    if (lines.some(function (l) { return l.name === name; })) {
      return { ok: false, msg: '线路名称已存在：' + name };
    }
    var line = Object.assign(
      { id: uid('l'), name: name, stationSeq: stationSeq.slice(), majorNos: majors },
      flags || {}
    );
    lines.push(line);
    if (!global.Storage.write(K.lines, lines)) return { ok: false, msg: '保存失败' };
    return { ok: true, line: line };
  }

  /** 线路是否被车次挂接引用 */
  function lineUsedByTrain(lineId) {
    return listTrains().some(function (t) { return t.lineId === lineId; });
  }

  function removeLine(id) {
    var lines = listLines();
    var idx = lines.findIndex(function (l) { return l.id === id; });
    if (idx === -1) return { ok: false, msg: '线路不存在' };
    if (lineUsedByTrain(id)) return { ok: false, msg: '该线路已被车次挂接，禁止删除' };
    lines.splice(idx, 1);
    if (!global.Storage.write(K.lines, lines)) return { ok: false, msg: '保存失败' };
    return { ok: true };
  }

  function getLine(id) {
    return listLines().find(function (l) { return l.id === id; }) || null;
  }

  /* ---------- 车次 ---------- */

  function addTrain(stationSeq, seatCount, lineId, codePrefix, customCode) {
    if (!Array.isArray(stationSeq) || stationSeq.length < 2) {
      return { ok: false, msg: '车次至少需要 2 个途经车站' };
    }
    var seen = {};
    for (var i = 0; i < stationSeq.length; i++) {
      if (seen[stationSeq[i]]) return { ok: false, msg: '站序中存在重复车站' };
      seen[stationSeq[i]] = true;
    }
    seatCount = Math.floor(Number(seatCount));
    if (!isFinite(seatCount) || seatCount < 1 || seatCount > 2147483647) {
      return { ok: false, msg: '座位数需为 1 ~ 2147483647 的整数' };
    }
    var train = { code: null, stationSeq: stationSeq.slice(), seatCount: seatCount };
    if (lineId) {
      var line = getLine(lineId);
      if (!line) return { ok: false, msg: '所挂接的线路不存在' };
      if (!isSubsequence(train.stationSeq, line.stationSeq)) {
        return { ok: false, msg: '车次站序必须是线路「' + line.name + '」站序的子序列（保持相对顺序）' };
      }
      train.lineId = lineId;
    }
    var code;
    var custom = String(customCode || '').trim().toUpperCase();
    if (custom) {
      // 自定义车次号：格式（字头 + 4 位，首位 1~3/6~8、末位奇数）+ 唯一性
      if (!isValidTrainCode(custom)) {
        return { ok: false, msg: '车次号格式不正确：需为 G/D/K + 4 位数字（首位 1~3/6~8，末位奇数），如 G1235' };
      }
      var usedCheck = new Set();
      listTrains().forEach(function (t) { usedCheck.add(t.code); });
      seq.trainCodes.forEach(function (c) { usedCheck.add(c); });
      if (usedCheck.has(custom)) return { ok: false, msg: '车次号已存在：' + custom };
      code = custom;
      seq.trainCodes.push(code);
      saveSeq();
    } else {
      code = allocateTrainCode(codePrefix);
      if (code === null) return { ok: false, msg: '车次号生成失败' };
    }
    train.code = code;
    var trains = listTrains();
    trains.push(train);
    if (!global.Storage.write(K.trains, trains)) return { ok: false, msg: '保存失败' };
    return { ok: true, train: train };
  }

  function removeTrain(code) {
    var trains = listTrains();
    var idx = trains.findIndex(function (t) { return t.code === code; });
    if (idx === -1) return { ok: false, msg: '车次不存在' };
    var used = listOrders().some(function (o) { return o.trainCode === code; });
    if (used) return { ok: false, msg: '该车次已存在订单，禁止删除' };
    trains.splice(idx, 1);
    if (!global.Storage.write(K.trains, trains)) return { ok: false, msg: '保存失败' };
    return { ok: true };
  }

  function getTrain(code) {
    return listTrains().find(function (t) { return t.code === code; }) || null;
  }

  /** 删除订单（退票/取消候补时由 ticketing 层在维护桶之后调用） */
  function removeOrder(id) {
    var orders = listOrders();
    var idx = orders.findIndex(function (o) { return o.id === id; });
    if (idx === -1) return { ok: false, msg: '订单不存在' };
    orders.splice(idx, 1);
    if (!global.Storage.write(K.orders, orders)) return { ok: false, msg: '保存失败' };
    return { ok: true };
  }

  /** 合法区间：站序中起点下标 < 终点下标 */
  function isValidRange(fromIdx, toIdx) {
    return fromIdx >= 0 && toIdx > fromIdx;
  }

  /* ---------- 导出 ---------- */

  global.Domain = {
    uid: uid,
    listStations: listStations,
    listLines: listLines,
    listTrains: listTrains,
    listOrders: listOrders,
    removeOrder: removeOrder,
    addStation: addStation,
    removeStation: removeStation,
    getStation: getStation,
    reassignStationNo: reassignStationNo,
    stationUsedByTrain: stationUsedByTrain,
    addLine: addLine,
    removeLine: removeLine,
    getLine: getLine,
    lineUsedByTrain: lineUsedByTrain,
    isSubsequence: isSubsequence,
    addTrain: addTrain,
    removeTrain: removeTrain,
    getTrain: getTrain,
    isValidTrainCode: isValidTrainCode,
    isValidRange: isValidRange,
    rebuildSeqPools: rebuildSeqPools
  };
})(window);
