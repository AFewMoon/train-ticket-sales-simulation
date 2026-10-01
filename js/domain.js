/* 领域层：车站 / 乘车人 / 车次的增删查、唯一号码与车次号生成、身份证与区间校验。
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
  function listPassengers() { return global.Storage.read(K.passengers, []); }
  function listTrains() { return global.Storage.read(K.trains, []); }
  function listOrders() { return global.Storage.read(K.orders, []); }
  function listLines() { return global.Storage.read(K.lines, []); }

  /* ---------- 唯一号码池 ---------- */

  var seq = global.Storage.read(K.seq, { stationNos: [], trainCodes: [] });

  function saveSeq() { global.Storage.write(K.seq, seq); }

  /** 随机取一个未被占用且不在排除集合中的元素；用尽返回 null */
  function randomPick(total, takenSet) {
    var pool = [];
    for (var i = 0; i < total; i++) if (!takenSet.has(i)) pool.push(i);
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

  /** 随机生成唯一车次号：G/D/K 前缀 + 3~4 位数字 */
  function allocateTrainCode() {
    var used = new Set();
    listTrains().forEach(function (t) { used.add(t.code); });
    seq.trainCodes.forEach(function (c) { used.add(c); });
    var prefixes = ['G', 'D', 'K'];
    for (var attempt = 0; attempt < 5000; attempt++) {
      var p = prefixes[Math.floor(Math.random() * 3)];
      var num = 100 + Math.floor(Math.random() * 9900); // 100-9999
      var code = p + num;
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

  /* ---------- 身份证校验 ---------- */

  var ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  var ID_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

  function isValidIdCard(id) {
    if (typeof id !== 'string') return false;
    id = id.trim().toUpperCase();
    if (!/^\d{17}[\dX]$/.test(id)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += Number(id[i]) * ID_WEIGHTS[i];
    return ID_CHECK_CODES[sum % 11] === id[17];
  }

  /** 身份证脱敏：保留前 4 位与后 4 位 */
  function maskIdCard(id) {
    if (!id || id.length < 8) return id;
    return id.slice(0, 4) + '***********' + id.slice(-4);
  }

  /** 按 17 位数字计算校验位，返回完整 18 位身份证号（供仿真批量构造合法证件） */
  function makeValidIdCard(digits17) {
    var d = String(digits17);
    if (!/^\d{17}$/.test(d)) return null;
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += Number(d[i]) * ID_WEIGHTS[i];
    return d + ID_CHECK_CODES[sum % 11];
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

  /* ---------- 乘车人 ---------- */

  function addPassenger(name, idCard) {
    name = String(name || '').trim();
    idCard = String(idCard || '').trim().toUpperCase();
    if (!name) return { ok: false, msg: '姓名不能为空' };
    if (!isValidIdCard(idCard)) return { ok: false, msg: '身份证号格式不正确（需通过 18 位校验位验证）' };
    var passengers = listPassengers();
    if (passengers.some(function (p) { return p.idCard === idCard; })) {
      return { ok: false, msg: '该身份证号已登记' };
    }
    var passenger = { id: uid('p'), name: name, idCard: idCard };
    passengers.push(passenger);
    if (!global.Storage.write(K.passengers, passengers)) return { ok: false, msg: '保存失败' };
    return { ok: true, passenger: passenger };
  }

  function removePassenger(id) {
    var passengers = listPassengers();
    var idx = passengers.findIndex(function (p) { return p.id === id; });
    if (idx === -1) return { ok: false, msg: '乘车人不存在' };
    var used = listOrders().some(function (o) { return o.passengerId === id; });
    if (used) return { ok: false, msg: '该乘车人已存在订单，禁止删除' };
    passengers.splice(idx, 1);
    if (!global.Storage.write(K.passengers, passengers)) return { ok: false, msg: '保存失败' };
    return { ok: true };
  }

  function getPassenger(id) {
    return listPassengers().find(function (p) { return p.id === id; }) || null;
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

  function addTrain(stationSeq, seatCount, lineId) {
    if (!Array.isArray(stationSeq) || stationSeq.length < 2) {
      return { ok: false, msg: '车次至少需要 2 个途经车站' };
    }
    var seen = {};
    for (var i = 0; i < stationSeq.length; i++) {
      if (seen[stationSeq[i]]) return { ok: false, msg: '站序中存在重复车站' };
      seen[stationSeq[i]] = true;
    }
    seatCount = Math.floor(Number(seatCount));
    if (!isFinite(seatCount) || seatCount < 1 || seatCount > 50) {
      return { ok: false, msg: '座位数需在 1-50 之间' };
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
    var code = allocateTrainCode();
    if (code === null) return { ok: false, msg: '车次号生成失败' };
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

  /** 合法区间：站序中起点下标 < 终点下标 */
  function isValidRange(fromIdx, toIdx) {
    return fromIdx >= 0 && toIdx > fromIdx;
  }

  /* ---------- 导出 ---------- */

  global.Domain = {
    uid: uid,
    listStations: listStations,
    listLines: listLines,
    listPassengers: listPassengers,
    listTrains: listTrains,
    listOrders: listOrders,
    addStation: addStation,
    removeStation: removeStation,
    getStation: getStation,
    stationUsedByTrain: stationUsedByTrain,
    addLine: addLine,
    removeLine: removeLine,
    getLine: getLine,
    lineUsedByTrain: lineUsedByTrain,
    isSubsequence: isSubsequence,
    addPassenger: addPassenger,
    removePassenger: removePassenger,
    getPassenger: getPassenger,
    addTrain: addTrain,
    removeTrain: removeTrain,
    getTrain: getTrain,
    isValidIdCard: isValidIdCard,
    makeValidIdCard: makeValidIdCard,
    maskIdCard: maskIdCard,
    isValidRange: isValidRange,
    rebuildSeqPools: rebuildSeqPools
  };
})(window);
