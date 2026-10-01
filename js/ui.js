/* UI 层：五面板渲染、下拉联动、座位区间图、表单事件绑定、toast 反馈。
   只做 DOM 与事件，业务逻辑调用 Domain / Ticketing。 */
(function (global) {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var Domain = global.Domain, Ticketing = global.Ticketing, Storage = global.Storage;

  var trainDraft = { stationSeq: [] }; // 车次表单草稿站序

  /* ================= Toast ================= */

  function toast(msg, type) {
    var box = $('#toast-box');
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.classList.add('hide');
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }

  /* ================= 通用渲染 ================= */

  function emptyState(text) {
    return '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<path d="M3 7h13v10H3zM16 10h3l2 3v4h-5M6.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>' +
      '<div>' + text + '</div></div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function confirmAction(msg) {
    return global.confirm(msg);
  }

  /* ================= 车站面板 ================= */

  function renderStations() {
    var stations = Domain.listStations();
    $('#station-count').textContent = stations.length + ' 座';
    var wrap = $('#station-table-wrap');
    if (!stations.length) {
      wrap.innerHTML = emptyState('暂无车站，请在左侧登记');
      return;
    }
    var rows = stations.map(function (s) {
      return '<tr><td><strong>' + escapeHtml(s.no) + '</strong></td><td>' + escapeHtml(s.nameZh) +
        '</td><td>' + escapeHtml(s.nameEn) +
        '</td><td><button class="btn btn-danger" data-del-station="' + escapeHtml(s.no) + '">删除</button></td></tr>';
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th>号码</th><th>中文名</th><th>英文名</th><th>操作</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function bindStationForm() {
    $('#station-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var zh = $('#station-name-zh').value;
      var en = $('#station-name-en').value;
      var res = Domain.addStation(zh, en);
      if (!res.ok) { toast(res.msg, 'error'); return; }
      toast('车站登记成功，号码：' + res.station.no, 'success');
      $('#station-name-zh').value = '';
      $('#station-name-en').value = '';
      renderAll();
    });
  }

  function bindStationDelete() {
    $('#station-table-wrap').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-del-station]');
      if (!btn) return;
      var no = btn.getAttribute('data-del-station');
      var s = Domain.getStation(no);
      if (!confirmAction('确认删除车站「' + (s ? s.nameZh : no) + '」（' + no + '）？')) return;
      var res = Domain.removeStation(no);
      toast(res.ok ? '车站已删除' : res.msg, res.ok ? 'success' : 'error');
      renderAll();
    });
  }

  /* ================= 线路面板 ================= */

  var lineDraft = { stationSeq: [], majorNos: [] }; // 线路表单草稿（含大站标记）

  function stationName(no) {
    var s = Domain.getStation(no);
    return s ? s.nameZh : no;
  }

  function isMajorInDraft(no) {
    return lineDraft.majorNos.indexOf(no) !== -1;
  }

  function renderLines() {
    var lines = Domain.listLines();
    $('#line-count').textContent = lines.length + ' 条';
    var wrap = $('#line-table-wrap');
    if (!lines.length) {
      wrap.innerHTML = emptyState('暂无线路，可在左侧登记');
      return;
    }
    var rows = lines.map(function (l) {
      var refCount = Domain.listTrains().filter(function (t) { return t.lineId === l.id; }).length;
      var seqHtml = l.stationSeq.map(function (no, i) {
        var major = (l.majorNos || []).indexOf(no) !== -1;
        return (i > 0 ? '<span class="chain-arrow">→</span>' : '') +
          '<span class="chain-node' + (major ? ' is-major' : '') + '">' + escapeHtml(stationName(no)) + (major ? ' ★' : '') + '</span>';
      }).join('');
      return '<tr><td>' + escapeHtml(l.name) + (l.builtin ? ' <span class="badge badge-major">内置</span>' : '') +
        '</td><td>' + seqHtml + '</td><td>' + refCount + ' 列' +
        '</td><td><button class="btn btn-danger" data-del-line="' + escapeHtml(l.id) + '">删除</button></td></tr>';
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th>线路</th><th>站序（★ 大站）</th><th>挂接车次</th><th>操作</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function refreshLineStationSelect() {
    var sel = $('#line-station-select');
    var stations = Domain.listStations();
    var inDraft = {};
    lineDraft.stationSeq.forEach(function (no) { inDraft[no] = true; });
    var options = stations.filter(function (s) { return !inDraft[s.no]; })
      .map(function (s) { return '<option value="' + escapeHtml(s.no) + '">' + escapeHtml(s.nameZh) + '（' + escapeHtml(s.no) + '）</option>'; })
      .join('');
    sel.innerHTML = options || '<option value="">无可用车站</option>';
  }

  function renderLineDraft() {
    var chain = $('#line-station-chain');
    if (!lineDraft.stationSeq.length) {
      chain.innerHTML = '<span class="hint">尚未选择车站，请先在「车站」页登记</span>';
      return;
    }
    var html = lineDraft.stationSeq.map(function (no, i) {
      var major = isMajorInDraft(no);
      var node = '<span class="chain-node' + (major ? ' is-major' : '') + '"><span class="idx">' + (i + 1) + '</span>' +
        escapeHtml(stationName(no)) +
        '<button type="button" class="chain-star' + (major ? ' is-on' : '') + '" data-toggle-major="' + i + '" title="标记/取消大站">' + (major ? '★' : '☆') + '</button>' +
        '<button type="button" class="chain-remove" data-remove-line-draft="' + i + '" title="移除">✕</button></span>';
      return (i > 0 ? '<span class="chain-arrow">→</span>' : '') + node;
    }).join('');
    chain.innerHTML = html;
  }

  function bindLineForm() {
    $('#add-line-station').addEventListener('click', function () {
      var no = $('#line-station-select').value;
      if (!no) { toast('无可用车站可选', 'error'); return; }
      lineDraft.stationSeq.push(no);
      renderLineDraft();
      refreshLineStationSelect();
    });

    $('#line-station-chain').addEventListener('click', function (e) {
      var rm = e.target.closest('[data-remove-line-draft]');
      if (rm) {
        var idx = Number(rm.getAttribute('data-remove-line-draft'));
        var removed = lineDraft.stationSeq.splice(idx, 1)[0];
        lineDraft.majorNos = lineDraft.majorNos.filter(function (no) { return no !== removed; });
        renderLineDraft();
        refreshLineStationSelect();
        return;
      }
      var star = e.target.closest('[data-toggle-major]');
      if (star) {
        var i = Number(star.getAttribute('data-toggle-major'));
        var no = lineDraft.stationSeq[i];
        var pos = lineDraft.majorNos.indexOf(no);
        if (pos === -1) lineDraft.majorNos.push(no);
        else lineDraft.majorNos.splice(pos, 1);
        renderLineDraft();
      }
    });

    $('#line-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = Domain.addLine($('#line-name').value, lineDraft.stationSeq, lineDraft.majorNos.slice());
      if (!res.ok) { toast(res.msg, 'error'); return; }
      toast('线路登记成功：' + res.line.name + '（' + res.line.stationSeq.length + ' 站，大站 ' + res.line.majorNos.length + ' 个）', 'success');
      $('#line-name').value = '';
      lineDraft.stationSeq = [];
      lineDraft.majorNos = [];
      renderLineDraft();
      refreshLineStationSelect();
      renderAll();
    });
  }

  function bindLineDelete() {
    $('#line-table-wrap').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-del-line]');
      if (!btn) return;
      var id = btn.getAttribute('data-del-line');
      var l = Domain.getLine(id);
      if (!confirmAction('确认删除线路「' + (l ? l.name : id) + '」？')) return;
      var res = Domain.removeLine(id);
      toast(res.ok ? '线路已删除' : res.msg, res.ok ? 'success' : 'error');
      renderAll();
    });
  }

  /* ================= 乘车人面板 ================= */

  function renderPassengers() {
    var passengers = Domain.listPassengers();
    $('#passenger-count').textContent = passengers.length + ' 人';
    var wrap = $('#passenger-table-wrap');
    if (!passengers.length) {
      wrap.innerHTML = emptyState('暂无乘车人，请在左侧登记');
      return;
    }
    var rows = passengers.map(function (p) {
      return '<tr><td>' + escapeHtml(p.name) + '</td><td><code>' + escapeHtml(Domain.maskIdCard(p.idCard)) +
        '</code></td><td><button class="btn btn-danger" data-del-passenger="' + escapeHtml(p.id) + '">删除</button></td></tr>';
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th>姓名</th><th>身份证号</th><th>操作</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function bindPassengerForm() {
    var input = $('#passenger-idcard');
    input.addEventListener('input', function () {
      var v = input.value.trim().toUpperCase();
      if (!v) { input.classList.remove('is-valid', 'is-invalid'); return; }
      input.classList.toggle('is-valid', Domain.isValidIdCard(v));
      input.classList.toggle('is-invalid', !Domain.isValidIdCard(v));
    });
    $('#passenger-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = Domain.addPassenger($('#passenger-name').value, input.value);
      if (!res.ok) { toast(res.msg, 'error'); return; }
      toast('乘车人登记成功：' + res.passenger.name, 'success');
      $('#passenger-name').value = '';
      input.value = '';
      input.classList.remove('is-valid', 'is-invalid');
      renderAll();
    });
  }

  function bindPassengerDelete() {
    $('#passenger-table-wrap').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-del-passenger]');
      if (!btn) return;
      var id = btn.getAttribute('data-del-passenger');
      var p = Domain.getPassenger(id);
      if (!confirmAction('确认删除乘车人「' + (p ? p.name : id) + '」？')) return;
      var res = Domain.removePassenger(id);
      toast(res.ok ? '乘车人已删除' : res.msg, res.ok ? 'success' : 'error');
      renderAll();
    });
  }

  /* ================= 车次面板 ================= */

  function renderTrainDraft() {
    var chain = $('#train-station-chain');
    if (!trainDraft.stationSeq.length) {
      chain.innerHTML = '<span class="hint">尚未选择车站，请先在「车站」页登记</span>';
      return;
    }
    var html = trainDraft.stationSeq.map(function (no, i) {
      var s = Domain.getStation(no);
      var name = s ? s.nameZh : no;
      var node = '<span class="chain-node"><span class="idx">' + (i + 1) + '</span>' + escapeHtml(name) +
        '<button type="button" class="chain-remove" data-remove-draft="' + i + '" title="移除">✕</button></span>';
      return (i > 0 ? '<span class="chain-arrow">→</span>' : '') + node;
    }).join('');
    chain.innerHTML = html;
  }

  function renderTrains() {
    var trains = Domain.listTrains();
    $('#train-count').textContent = trains.length + ' 列';
    var wrap = $('#train-table-wrap');
    if (!trains.length) {
      wrap.innerHTML = emptyState('暂无车次，请在左侧登记');
      return;
    }
    var codeBadge = function (code) {
      var cls = 'badge-code-' + code[0].toLowerCase();
      return '<span class="badge ' + cls + '">' + escapeHtml(code) + '</span>';
    };
    var rows = trains.map(function (t) {
      var line = t.lineId ? Domain.getLine(t.lineId) : null;
      var lineBadge = line ? ' <span class="badge badge-count">' + escapeHtml(line.name) + '</span>' : '';
      var simBadge = t.sim ? ' <span class="badge badge-type-skip">仿真</span>' : '';
      var seqHtml = t.stationSeq.map(function (no, i) {
        var s = Domain.getStation(no);
        var name = s ? s.nameZh : no;
        var major = line && (line.majorNos || []).indexOf(no) !== -1;
        return (i > 0 ? '<span class="chain-arrow">→</span>' : '') +
          '<span class="chain-node' + (major ? ' is-major" title="大站' : '"') + '">' + escapeHtml(name) + (major ? '★' : '') + '</span>';
      }).join('');
      return '<tr><td>' + codeBadge(t.code) + lineBadge + simBadge + '</td><td>' + seqHtml + '</td><td>' + t.seatCount +
        ' 座</td><td><button class="btn btn-danger" data-del-train="' + escapeHtml(t.code) + '">删除</button></td></tr>';
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th>车次</th><th>站序</th><th>座位数</th><th>操作</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function refreshTrainLineSelect() {
    var sel = $('#train-line');
    var lines = Domain.listLines();
    var prev = sel.value;
    sel.innerHTML = '<option value="">不挂接线路</option>' +
      lines.map(function (l) {
        return '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '（' + l.stationSeq.length + ' 站）</option>';
      }).join('');
    if (prev && lines.some(function (l) { return l.id === prev; })) sel.value = prev;
  }

  function refreshTrainStationSelect() {
    var sel = $('#train-station-select');
    var lineId = $('#train-line') ? $('#train-line').value : '';
    var line = lineId ? Domain.getLine(lineId) : null;
    var inDraft = {};
    trainDraft.stationSeq.forEach(function (no) { inDraft[no] = true; });

    var candidates;
    if (line) {
      // 挂线：候选 = 线路站序中最后一个已选站之后的站（随路线成形单调收缩）
      var lastIdx = -1;
      trainDraft.stationSeq.forEach(function (no) {
        var idx = line.stationSeq.indexOf(no);
        if (idx > lastIdx) lastIdx = idx;
      });
      candidates = line.stationSeq.slice(lastIdx + 1)
        .filter(function (no) { return !inDraft[no]; });
    } else {
      candidates = Domain.listStations()
        .map(function (s) { return s.no; })
        .filter(function (no) { return !inDraft[no]; });
    }
    var options = candidates.map(function (no) {
      var s = Domain.getStation(no);
      return '<option value="' + escapeHtml(no) + '">' + escapeHtml(s ? s.nameZh : no) + '（' + escapeHtml(no) + '）</option>';
    }).join('');
    sel.innerHTML = options || '<option value="">无可用车站' + (line ? '——线路剩余站已选完' : '') + '</option>';
  }

  function bindTrainForm() {
    $('#add-train-station').addEventListener('click', function () {
      var no = $('#train-station-select').value;
      if (!no) { toast('无可用车站可选', 'error'); return; }
      trainDraft.stationSeq.push(no);
      renderTrainDraft();
      refreshTrainStationSelect();
    });

    $('#train-station-chain').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove-draft]');
      if (!btn) return;
      trainDraft.stationSeq.splice(Number(btn.getAttribute('data-remove-draft')), 1);
      renderTrainDraft();
      refreshTrainStationSelect();
    });

    $('#seat-minus').addEventListener('click', function () {
      var input = $('#train-seat-count');
      input.value = Math.max(1, (Number(input.value) || 1) - 1);
    });
    $('#seat-plus').addEventListener('click', function () {
      var input = $('#train-seat-count');
      input.value = Math.min(2147483647, (Number(input.value) || 1) + 1);
    });

    // 挂接线路变化时，途经站候选范围随路线成形收缩
    $('#train-line').addEventListener('change', refreshTrainStationSelect);

    $('#train-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var lineId = $('#train-line').value || null;
      var customCode = $('#train-code').value.trim();
      var res = Domain.addTrain(trainDraft.stationSeq, $('#train-seat-count').value, lineId, null, customCode);
      if (!res.ok) { toast(res.msg, 'error'); return; }
      toast('车次登记成功：' + res.train.code, 'success');
      trainDraft.stationSeq = [];
      $('#train-seat-count').value = 5;
      $('#train-code').value = '';
      renderTrainDraft();
      refreshTrainStationSelect();
      renderAll();
    });
  }

  function bindTrainDelete() {
    $('#train-table-wrap').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-del-train]');
      if (!btn) return;
      var code = btn.getAttribute('data-del-train');
      if (!confirmAction('确认删除车次 ' + code + '？')) return;
      var res = Domain.removeTrain(code);
      toast(res.ok ? '车次已删除' : res.msg, res.ok ? 'success' : 'error');
      renderAll();
    });
  }

  /* ================= 购票面板 ================= */

  function renderBooking() {
    // 乘车人下拉
    var pSel = $('#booking-passenger');
    var passengers = Domain.listPassengers();
    var prevP = pSel.value;
    pSel.innerHTML = passengers.length
      ? passengers.map(function (p) { return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>'; }).join('')
      : '<option value="">请先登记乘车人</option>';
    if (prevP && passengers.some(function (p) { return p.id === prevP; })) pSel.value = prevP;

    // 车次下拉
    var tSel = $('#booking-train');
    var trains = Domain.listTrains();
    var prevT = tSel.value;
    tSel.innerHTML = trains.length
      ? trains.map(function (t) { return '<option value="' + escapeHtml(t.code) + '">' + escapeHtml(t.code) + '</option>'; }).join('')
      : '<option value="">请先登记车次</option>';
    if (prevT && trains.some(function (t) { return t.code === prevT; })) tSel.value = prevT;

    renderCapacityHint();
    renderRangeSelects();
    renderWaitingList();
  }

  function renderCapacityHint() {
    var code = $('#booking-train').value;
    var hint = $('#booking-capacity');
    var train = code ? Domain.getTrain(code) : null;
    if (!train) { hint.textContent = '请选择车次'; return; }
    var summary = Ticketing.capacitySummary(train, Ticketing.ordersOfTrain(code));
    var issued = Ticketing.ordersOfTrain(code).filter(function (o) { return o.status === 'issued'; }).length;
    hint.textContent = train.code + '：' + train.seatCount + ' 座，共 ' + summary.totalSegments +
      ' 个区间段，剩余空闲区间段 ' + summary.freeSegments + ' 个；已出票 ' + issued + ' 单，候补 ' +
      Ticketing.waitingOrdersOfTrain(code).length + ' 单';
  }

  /** 起点/终点联动：起点下拉展示全部站序；终点仅展示起点之后的站 */
  function renderRangeSelects() {
    var code = $('#booking-train').value;
    var train = code ? Domain.getTrain(code) : null;
    var fromSel = $('#booking-from'), toSel = $('#booking-to');
    if (!train) {
      fromSel.innerHTML = '<option value="">—</option>';
      toSel.innerHTML = '<option value="">—</option>';
      toSel.disabled = true;
      return;
    }
    toSel.disabled = false;
    var prevFrom = fromSel.value;
    fromSel.innerHTML = train.stationSeq.map(function (no, i) {
      var s = Domain.getStation(no);
      return '<option value="' + i + '">' + escapeHtml(s ? s.nameZh : no) + '</option>';
    }).join('');
    if (prevFrom !== '' && Number(prevFrom) < train.stationSeq.length) fromSel.value = prevFrom;
    renderToOptions();
  }

  function renderToOptions() {
    var code = $('#booking-train').value;
    var train = code ? Domain.getTrain(code) : null;
    if (!train) return;
    var fromIdx = Number($('#booking-from').value) || 0;
    var toSel = $('#booking-to');
    var prevTo = toSel.value;
    var options = '';
    for (var i = fromIdx + 1; i < train.stationSeq.length; i++) {
      var no_ = train.stationSeq[i];
      var s = Domain.getStation(no_);
      options += '<option value="' + i + '">' + escapeHtml(s ? s.nameZh : no_) + '</option>';
    }
    toSel.innerHTML = options || '<option value="">无合法终点</option>';
    if (prevTo && Number(prevTo) > fromIdx && Number(prevTo) < train.stationSeq.length) toSel.value = prevTo;
  }

  function renderWaitingList() {
    var waiting = Ticketing.allWaitingOrders()
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
    var box = $('#waiting-list');
    if (!waiting.length) {
      box.innerHTML = emptyState('当前没有候补订单');
      return;
    }
    // 按车次分组显示名次
    var counters = {};
    var html = waiting.map(function (o) {
      counters[o.trainCode] = (counters[o.trainCode] || 0) + 1;
      var train = Domain.getTrain(o.trainCode);
      var p = Domain.getPassenger(o.passengerId);
      var st = train ? train.stationSeq : [];
      var fs = st[o.fromIdx], ts = st[o.toIdx];
      var f = Domain.getStation(fs), t = Domain.getStation(ts);
      return '<div class="waiting-item"><span>' + escapeHtml(o.trainCode) + ' · ' +
        escapeHtml(p ? p.name : '未知') + ' · ' +
        escapeHtml(f ? f.nameZh : fs) + ' → ' + escapeHtml(t ? t.nameZh : ts) +
        '</span><span class="pos">候补第 ' + counters[o.trainCode] + ' 位</span></div>';
    }).join('');
    box.innerHTML = html;
  }

  function bindBookingForm() {
    $('#booking-train').addEventListener('change', function () {
      renderCapacityHint();
      renderRangeSelects();
    });
    $('#booking-from').addEventListener('change', renderToOptions);

    $('#booking-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var pid = $('#booking-passenger').value;
      var code = $('#booking-train').value;
      var fromIdx = Number($('#booking-from').value);
      var toIdx = Number($('#booking-to').value);
      if (!pid) { toast('请先登记乘车人', 'error'); return; }
      if (!code) { toast('请先登记车次', 'error'); return; }
      if (isNaN(fromIdx) || isNaN(toIdx) || !Domain.isValidRange(fromIdx, toIdx)) {
        toast('请选择合法乘车区间', 'error');
        return;
      }
      var res = Ticketing.purchase(code, pid, fromIdx, toIdx);
      if (!res.ok) { toast(res.msg, 'error'); return; }
      if (res.issued) {
        toast('出票成功！座位号：' + res.seatNo, 'success');
      } else {
        toast('暂无合适组合，订单进入候补等待（第 ' + res.position + ' 位）', 'info');
      }
      renderAll();
    });
  }

  /* ================= 订单与座位面板 ================= */

  function renderOrders() {
    var orders = Domain.listOrders()
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
    $('#order-count').textContent = orders.length + ' 单';
    var wrap = $('#order-table-wrap');
    if (!orders.length) {
      wrap.innerHTML = emptyState('暂无订单，请前往「购票」页下单');
      return;
    }
    var rows = orders.map(function (o) {
      var train = Domain.getTrain(o.trainCode);
      var p = Domain.getPassenger(o.passengerId);
      var st = train ? train.stationSeq : [];
      var f = Domain.getStation(st[o.fromIdx]), t = Domain.getStation(st[o.toIdx]);
      var status = o.status === 'issued'
        ? '<span class="badge badge-issued">已出票</span>'
        : '<span class="badge badge-waiting">候补中</span>';
      var op = '<button class="btn btn-danger" data-refund-order="' + escapeHtml(o.id) + '">' +
        (o.status === 'issued' ? '退票' : '取消候补') + '</button>';
      return '<tr><td>' + escapeHtml(o.trainCode) + '</td><td>' + escapeHtml(p ? p.name : '未知') +
        '</td><td>' + escapeHtml(f ? f.nameZh : st[o.fromIdx]) + ' → ' + escapeHtml(t ? t.nameZh : st[o.toIdx]) +
        '</td><td>' + status + '</td><td>' + (o.seatNo !== undefined && o.seatNo !== null ? '第 ' + o.seatNo + ' 号座位' : '—') +
        '</td><td>' + op + '</td></tr>';
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th>车次</th><th>乘车人</th><th>区间</th><th>状态</th><th>座位</th><th>操作</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function bindOrderRefund() {
    $('#order-table-wrap').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-refund-order]');
      if (!btn) return;
      var id = btn.getAttribute('data-refund-order');
      if (!confirmAction('确认退票 / 取消该订单？座位区间将释放并自动触发候补兑现。')) return;
      var res = global.Ticketing.refundOrder(id);
      if (!res.ok) { toast(res.msg, 'error'); return; }
      toast(res.fulfilled > 0 ? '退票成功，候补兑现 ' + res.fulfilled + ' 单' : '退票成功', 'success');
      renderAll();
    });
  }

  /* ================= 事件时间线 ================= */

  function relTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function renderEventLog() {
    var box = $('#event-timeline');
    var events = global.Ticketing.Events.list(50);
    if (!events.length) {
      box.innerHTML = emptyState('暂无事件，购票 / 出票 / 退票后在此实时记录');
      return;
    }
    var types = global.Ticketing.Events.TYPES;
    box.innerHTML = events.map(function (ev) {
      var meta = types[ev.type] || { label: ev.type, cls: '' };
      var train = ev.trainCode ? ' · ' + escapeHtml(ev.trainCode) : '';
      return '<div class="ev-item ' + meta.cls + '">' +
        '<div class="ev-head"><span class="ev-badge">' + meta.label + '</span>' +
        '<span class="ev-time">' + relTime(ev.ts) + train + '</span></div>' +
        '<div class="ev-detail">' + escapeHtml(ev.detail) + '</div></div>';
    }).join('');
  }

  /** 座位区间图：每行一个座位，彩色区间块按站点轴定位 */
  var SEG_COLORS = ['#2563EB', '#16A34A', '#F59E0B', '#DC2626', '#7C3AED', '#0891B2', '#DB2777', '#65A30D'];

  /** 生成单趟车次的座位图 HTML（订单页与仿真结果页共用）；
      站点多时内部轨道按站数展宽，外层容器左右滑动，避免站名文字重叠 */
  function renderTrainSeatMapHtml(train, issued) {
    var html = '';
    var S = train.stationSeq.length;
    var innerMinWidth = Math.max(560, S * 72);
    html += '<div class="seat-scroll"><div class="seat-inner" style="min-width:' + innerMinWidth + 'px;">';
    var line = train.lineId ? Domain.getLine(train.lineId) : null;
    var typeMeta = global.Simulation.TYPE_META[global.Simulation.typeOfTrain(train)];

    // 站名轴（大站加 ★）
    html += '<div class="seat-axis"><div class="axis-spacer"></div><div class="axis-track">';
    for (var i = 0; i < S; i++) {
      var s = Domain.getStation(train.stationSeq[i]);
      var pos = (i / (S - 1)) * 100;
      var name = (s ? s.nameZh : train.stationSeq[i]) + (line && (line.majorNos || []).indexOf(train.stationSeq[i]) !== -1 ? '★' : '');
      var align = i === 0 ? '0' : (i === S - 1 ? '100%' : pos + '%');
      var transform = i === 0 ? 'translateX(0)' : (i === S - 1 ? 'translateX(-100%)' : 'translateX(-50%)');
      html += '<span class="axis-tick" style="left:' + align + ';transform:' + transform + ';">' + escapeHtml(name) + '</span>';
    }
    html += '</div></div>';

    html += '<div style="font-weight:700;color:var(--text-2);font-size:13px;margin-top:6px;">' +
      '<span class="badge badge-code-' + train.code[0].toLowerCase() + '">' + escapeHtml(train.code) + '</span>' +
      (typeMeta ? ' <span class="badge ' + typeMeta.badge + '">' + typeMeta.label + '</span>' : '') +
      (line ? ' <span class="badge badge-count">' + escapeHtml(line.name) + '</span>' : '') +
      '</div>';

    for (var seat = 1; seat <= train.seatCount; seat++) {
      var segs = issued.filter(function (o) { return o.seatNo === seat; })
        .sort(function (a, b) { return a.fromIdx - b.fromIdx; });
      html += '<div class="seat-row"><div class="seat-label">座位 ' + seat + '</div><div class="seat-track">';
      segs.forEach(function (o, idx) {
        var left = (o.fromIdx / (S - 1)) * 100;
        var width = ((o.toIdx - o.fromIdx) / (S - 1)) * 100;
        var p = Domain.getPassenger(o.passengerId);
        var f = Domain.getStation(train.stationSeq[o.fromIdx]);
        var t = Domain.getStation(train.stationSeq[o.toIdx]);
        var color = SEG_COLORS[(o.id.charCodeAt(o.id.length - 1) + idx) % SEG_COLORS.length];
        html += '<div class="seat-seg" style="left:' + left + '%;width:' + width + '%;background:' + color + ';"' +
          ' data-tip="' + escapeHtml(p ? p.name : '未知') + '：' + escapeHtml(f ? f.nameZh : '') + ' → ' + escapeHtml(t ? t.nameZh : '') + '">' +
          escapeHtml(f ? f.nameZh : '') + '→' + escapeHtml(t ? t.nameZh : '') + '</div>';
      });
      html += '</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderSeatMap() {
    var box = $('#seat-map');
    var trains = Domain.listTrains();
    var anyIssued = Domain.listOrders().some(function (o) { return o.status === 'issued'; });
    if (!trains.length || !anyIssued) {
      box.innerHTML = emptyState('暂无已出票订单，出票后可在此查看每个座位的区间拼接');
      return;
    }

    var html = '';
    trains.forEach(function (train) {
      var issued = Ticketing.ordersOfTrain(train.code).filter(function (o) { return o.status === 'issued'; });
      if (!issued.length) return;
      html += renderTrainSeatMapHtml(train, issued);
    });

    box.innerHTML = html || emptyState('暂无已出票订单');
  }

  /* ================= 自动仿真面板 ================= */

  var lastSimSummary = null; // 保留最近一次仿真结果，切页签不丢

  function refreshSimLineSelect() {
    var sel = $('#sim-line');
    var lines = Domain.listLines();
    var prev = sel.value;
    sel.innerHTML = lines.map(function (l) {
      return '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '（' + l.stationSeq.length + ' 站 · 大站 ' + (l.majorNos || []).length + '）</option>';
    }).join('') + '<option value="__auto__">＋ 自动生成模拟线路</option>';
    if (prev && (lines.some(function (l) { return l.id === prev; }) || prev === '__auto__')) sel.value = prev;
    syncSimAutoField();
  }

  function syncSimAutoField() {
    $('#sim-auto-field').hidden = $('#sim-line').value !== '__auto__';
  }

  function renderSimResults() {
    if (!lastSimSummary) return;
    var s = lastSimSummary;

    // 统计卡片
    $('#sim-stats').innerHTML =
      statCard('总请求', s.totalRequests, 'is-blue') +
      statCard('已出票', s.totalIssued, 'is-green') +
      statCard('候补中', s.totalWaiting, 'is-amber') +
      statCard('出票率', s.issuedRate.toFixed(1) + '%', 'is-green');

    // 每车次摘要表
    var meta = global.Simulation.TYPE_META;
    var rows = Object.keys(s.perTrain).map(function (code) {
      var st = s.perTrain[code];
      var tm = meta[global.Simulation.typeOfTrain(st.train)];
      var stops = st.train.stationSeq.length;
      var majors = st.train.stationSeq.filter(function (no) {
        return (s.summaryLineMajorNos || []).indexOf(no) !== -1;
      }).length;
      return '<tr><td><strong>' + escapeHtml(code) + '</strong></td>' +
        '<td><span class="badge ' + (tm ? tm.badge : 'badge-count') + '">' + (tm ? tm.label : '自定义') + '</span></td>' +
        '<td>' + st.train.seatCount + ' 座 / 停 ' + stops + ' 站（大站 ' + majors + '）</td>' +
        '<td>' + st.requests + '</td><td style="color:var(--green);font-weight:700;">' + st.issued + '</td>' +
        '<td style="color:#B45309;font-weight:700;">' + st.waiting + '</td></tr>';
    }).join('');
    $('#sim-summary').innerHTML = '<table><thead><tr><th>车次</th><th>类型</th><th>运力</th><th>请求</th><th>出票</th><th>候补</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
    $('#sim-summary-card').hidden = false;

    // 按车次分组的座位图
    var html = '';
    s.trains.forEach(function (t) {
      var issued = Ticketing.ordersOfTrain(t.code).filter(function (o) { return o.status === 'issued'; });
      if (!issued.length) return;
      html += renderTrainSeatMapHtml(t, issued);
    });
    $('#sim-seatmap').innerHTML = html || emptyState('本次仿真无出票订单');
    $('#sim-seatmap-card').hidden = false;
  }

  function statCard(label, value, cls) {
    return '<div class="stat-card ' + (cls || '') + '"><div class="stat-label">' + label + '</div>' +
      '<div class="stat-value">' + value + '</div></div>';
  }

  function bindSimForm() {
    $('#sim-line').addEventListener('change', syncSimAutoField);

    $('#sim-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var cfg = {
        lineId: $('#sim-line').value,
        autoStationCount: Number($('#sim-auto-stations').value) || 10,
        countDirect: $('#sim-count-direct').value,
        countExpress: $('#sim-count-express').value,
        countSkip: $('#sim-count-skip').value,
        seats: $('#sim-seats').value,
        passengers: $('#sim-passengers').value,
        requests: $('#sim-requests').value,
        seed: $('#sim-seed').value
      };
      var res = global.Simulation.runSimulation(cfg);
      if (!res.ok) { toast(res.msg, 'error'); return; }
      lastSimSummary = res.summary;
      // 提供线路大站集合供摘要表标注
      lastSimSummary.summaryLineMajorNos = res.summary.line.majorNos || [];
      // 随机种子（-1）回显实际使用的种子，便于复现
      $('#sim-seed').value = res.summary.usedSeed;
      renderSimResults();
      toast('仿真完成（种子 ' + res.summary.usedSeed + '）: ' + res.summary.totalRequests + ' 次请求，出票 ' +
        res.summary.totalIssued + '，候补 ' + res.summary.totalWaiting, 'success');
      renderAll();
    });

    $('#sim-cleanup').addEventListener('click', function () {
      if (!confirmAction('确认清理全部仿真数据（sim 标记的线路/车次/乘车人/订单与自动生成的模拟车站）？手动登记的数据不受影响。')) return;
      global.Simulation.cleanupSimulation();
      lastSimSummary = null;
      $('#sim-stats').innerHTML = '<div class="empty-state">仿真数据已清理，可重新配置参数运行</div>';
      $('#sim-summary-card').hidden = true;
      $('#sim-seatmap-card').hidden = true;
      toast('仿真数据已清理', 'success');
      renderAll();
    });
  }

  /* ================= 数据查询区 ================= */

  var queryState = { trainCode: '', segIdx: -1 };

  function renderQueryArea() {
    var trains = Domain.listTrains();
    var tSel = $('#query-train'), sSel = $('#query-segment');
    if (!trains.some(function (t) { return t.code === queryState.trainCode; })) {
      queryState.trainCode = trains.length ? trains[0].code : '';
      queryState.segIdx = -1;
    }
    tSel.innerHTML = trains.length
      ? trains.map(function (t) { return '<option value="' + escapeHtml(t.code) + '">' + escapeHtml(t.code) + '</option>'; }).join('')
      : '<option value="">无车次</option>';
    tSel.value = queryState.trainCode;

    var train = Domain.getTrain(queryState.trainCode);
    if (train) {
      var prevSeg = queryState.segIdx;
      var opts = '<option value="-1">全部订单</option>';
      for (var i = 0; i < train.stationSeq.length - 1; i++) {
        var f = Domain.getStation(train.stationSeq[i]);
        var t2 = Domain.getStation(train.stationSeq[i + 1]);
        opts += '<option value="' + i + '">' + escapeHtml(f ? f.nameZh : i) + '—' + escapeHtml(t2 ? t2.nameZh : (i + 1)) + ' 段</option>';
      }
      sSel.innerHTML = opts;
      sSel.value = String(prevSeg >= -1 && prevSeg < train.stationSeq.length - 1 ? prevSeg : -1);
      sSel.disabled = false;
    } else {
      sSel.innerHTML = '<option value="-1">—</option>';
      sSel.disabled = true;
    }
    renderQueryResult();
  }

  function renderQueryResult() {
    var box = $('#query-result');
    var train = Domain.getTrain(queryState.trainCode);
    if (!train) {
      box.innerHTML = emptyState('暂无车次数据');
      return;
    }
    var all = Ticketing.ordersOfTrain(train.code)
      .sort(function (a, b) { return a.createdAt - b.createdAt; });

    if (queryState.segIdx < 0) {
      // 该车次全部订单
      if (!all.length) {
        box.innerHTML = emptyState('该车次暂无订单');
        return;
      }
      var rows = all.map(function (o) {
        var p = Domain.getPassenger(o.passengerId);
        var st = train.stationSeq;
        var f = Domain.getStation(st[o.fromIdx]), t = Domain.getStation(st[o.toIdx]);
        var status = o.status === 'issued'
          ? '<span class="badge badge-issued">已出票</span>'
          : '<span class="badge badge-waiting">候补中</span>';
        return '<tr><td>' + escapeHtml(p ? p.name : '未知') + '</td>' +
          '<td>' + escapeHtml(f ? f.nameZh : st[o.fromIdx]) + ' → ' + escapeHtml(t ? t.nameZh : st[o.toIdx]) + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + (o.seatNo !== undefined && o.seatNo !== null ? '第 ' + o.seatNo + ' 号' : '—') + '</td>' +
          '<td>' + escapeHtml(p ? Domain.maskIdCard(p.idCard) : '—') + '</td></tr>';
      }).join('');
      box.innerHTML = '<table><thead><tr><th>乘车人</th><th>区间</th><th>状态</th><th>座位</th><th>证件号</th></tr></thead><tbody>' +
        rows + '</tbody></table>';
      return;
    }

    // 该相邻区间段上的乘客（已出票且旅程覆盖该段）
    var seg = queryState.segIdx;
    var onSeg = all.filter(function (o) {
      return o.status === 'issued' && o.fromIdx <= seg && o.toIdx > seg;
    });
    var f = Domain.getStation(train.stationSeq[seg]);
    var t = Domain.getStation(train.stationSeq[seg + 1]);
    var title = escapeHtml(f ? f.nameZh : seg) + ' — ' + escapeHtml(t ? t.nameZh : (seg + 1)) + ' 段';
    if (!onSeg.length) {
      box.innerHTML = emptyState(title + '：本段暂无已出票乘客');
      return;
    }
    var rows2 = onSeg.map(function (o) {
      var p = Domain.getPassenger(o.passengerId);
      var st = train.stationSeq;
      var jf = Domain.getStation(st[o.fromIdx]), jt = Domain.getStation(st[o.toIdx]);
      return '<tr><td>' + escapeHtml(p ? p.name : '未知') + '</td>' +
        '<td><code>' + escapeHtml(p ? Domain.maskIdCard(p.idCard) : '—') + '</code></td>' +
        '<td>' + escapeHtml(jf ? jf.nameZh : st[o.fromIdx]) + ' → ' + escapeHtml(jt ? jt.nameZh : st[o.toIdx]) + '</td>' +
        '<td>第 ' + o.seatNo + ' 号座位</td></tr>';
    }).join('');
    box.innerHTML = '<p class="hint" style="margin: 4px 0 8px;">' + title + '：共 ' + onSeg.length + ' 名乘客</p>' +
      '<table><thead><tr><th>乘客</th><th>证件号</th><th>完整旅程</th><th>座位</th></tr></thead><tbody>' +
      rows2 + '</tbody></table>';
  }

  function bindQueryControls() {
    $('#query-train').addEventListener('change', function () {
      queryState.trainCode = this.value;
      queryState.segIdx = -1;
      renderQueryArea();
    });
    $('#query-segment').addEventListener('change', function () {
      queryState.segIdx = Number(this.value);
      renderQueryResult();
    });
  }

  /* ================= 退票模拟 ================= */

  function bindRefundSim() {
    $('#refund-sim-btn').addEventListener('click', function () {
      var rate = Number($('#refund-rate').value);
      if (!isFinite(rate) || rate < 1 || rate > 100) { toast('退票比率需在 1-100 之间', 'error'); return; }
      var issued = Domain.listOrders().filter(function (o) { return o.status === 'issued'; });
      if (!issued.length) { toast('当前没有已出票订单', 'info'); return; }
      var count = Math.max(1, Math.round(issued.length * rate / 100));
      // 随机抽取不重复的订单逐张退票（refundOrder 内部自动按时间戳补录）
      for (var i = issued.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = issued[i]; issued[i] = issued[j]; issued[j] = tmp;
      }
      var refunded = 0, fulfilled = 0;
      for (var k = 0; k < count && k < issued.length; k++) {
        var r = global.Ticketing.refundOrder(issued[k].id);
        if (r.ok) { refunded++; fulfilled += r.fulfilled || 0; }
      }
      toast('退票模拟：退 ' + refunded + ' 张，候补补录 ' + fulfilled + ' 单', 'success');
      renderAll();
    });
  }

  /* ================= 标签切换 ================= */

  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-tab') === name;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      var active = p.id === 'panel-' + name;
      p.classList.toggle('is-active', active);
      if (active) { p.hidden = false; } else { p.hidden = true; }
    });
    renderAll();
  }

  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-tab'));
      });
    });
  }

  /* ================= 汇总渲染 ================= */

  function renderAll() {
    renderStations();
    renderLines();
    refreshLineStationSelect();
    renderLineDraft();
    renderPassengers();
    refreshTrainStationSelect();
    refreshTrainLineSelect();
    renderTrainDraft();
    renderTrains();
    renderBooking();
    renderOrders();
    renderQueryArea();
    renderSeatMap();
    refreshSimLineSelect();
    renderSimResults();
    renderEventLog();
  }

  /* ================= 导出 ================= */

  global.UI = {
    toast: toast,
    bindAll: function () {
      bindTabs();
      bindStationForm();
      bindStationDelete();
      bindLineForm();
      bindLineDelete();
      bindPassengerForm();
      bindPassengerDelete();
      bindTrainForm();
      bindTrainDelete();
      bindBookingForm();
      bindOrderRefund();
      bindQueryControls();
      bindRefundSim();
      bindSimForm();
    },
    renderAll: renderAll,
    switchTab: switchTab
  };
})(window);
