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
      var seqHtml = t.stationSeq.map(function (no, i) {
        var s = Domain.getStation(no);
        var name = s ? s.nameZh : no;
        return (i > 0 ? '<span class="chain-arrow">→</span>' : '') + '<span class="chain-node">' + escapeHtml(name) + '</span>';
      }).join('');
      return '<tr><td>' + codeBadge(t.code) + '</td><td>' + seqHtml + '</td><td>' + t.seatCount +
        ' 座</td><td><button class="btn btn-danger" data-del-train="' + escapeHtml(t.code) + '">删除</button></td></tr>';
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th>车次</th><th>站序</th><th>座位数</th><th>操作</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function refreshTrainStationSelect() {
    var sel = $('#train-station-select');
    var stations = Domain.listStations();
    var inDraft = {};
    trainDraft.stationSeq.forEach(function (no) { inDraft[no] = true; });
    var options = stations.filter(function (s) { return !inDraft[s.no]; })
      .map(function (s) { return '<option value="' + escapeHtml(s.no) + '">' + escapeHtml(s.nameZh) + '（' + escapeHtml(s.no) + '）</option>'; })
      .join('');
    sel.innerHTML = options || '<option value="">无可用车站</option>';
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
      input.value = Math.min(50, (Number(input.value) || 1) + 1);
    });

    $('#train-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = Domain.addTrain(trainDraft.stationSeq, $('#train-seat-count').value);
      if (!res.ok) { toast(res.msg, 'error'); return; }
      toast('车次登记成功：' + res.train.code, 'success');
      trainDraft.stationSeq = [];
      $('#train-seat-count').value = 5;
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
      return '<tr><td>' + escapeHtml(o.trainCode) + '</td><td>' + escapeHtml(p ? p.name : '未知') +
        '</td><td>' + escapeHtml(f ? f.nameZh : st[o.fromIdx]) + ' → ' + escapeHtml(t ? t.nameZh : st[o.toIdx]) +
        '</td><td>' + status + '</td><td>' + (o.seatNo !== undefined && o.seatNo !== null ? '第 ' + o.seatNo + ' 号座位' : '—') +
        '</td></tr>';
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th>车次</th><th>乘车人</th><th>区间</th><th>状态</th><th>座位</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  /** 座位区间图：每行一个座位，彩色区间块按站点轴定位 */
  function renderSeatMap() {
    var box = $('#seat-map');
    var trains = Domain.listTrains();
    var anyIssued = Domain.listOrders().some(function (o) { return o.status === 'issued'; });
    if (!trains.length || !anyIssued) {
      box.innerHTML = emptyState('暂无已出票订单，出票后可在此查看每个座位的区间拼接');
      return;
    }

    var colors = ['#2563EB', '#16A34A', '#F59E0B', '#DC2626', '#7C3AED', '#0891B2', '#DB2777', '#65A30D'];
    var html = '';

    trains.forEach(function (train) {
      var issued = Ticketing.ordersOfTrain(train.code).filter(function (o) { return o.status === 'issued'; });
      if (!issued.length) return;
      var S = train.stationSeq.length;

      // 站名轴
      html += '<div class="seat-axis"><div class="axis-spacer"></div><div class="axis-track">';
      for (var i = 0; i < S; i++) {
        var s = Domain.getStation(train.stationSeq[i]);
        var pos = (i / (S - 1)) * 100;
        var name = s ? s.nameZh : train.stationSeq[i];
        var align = i === 0 ? '0' : (i === S - 1 ? '100%' : pos + '%');
        var transform = i === 0 ? 'translateX(0)' : (i === S - 1 ? 'translateX(-100%)' : 'translateX(-50%)');
        html += '<span class="axis-tick" style="left:' + align + ';transform:' + transform + ';">' + escapeHtml(name) + '</span>';
      }
      html += '</div></div>';

      html += '<div style="font-weight:700;color:var(--text-2);font-size:13px;margin-top:6px;">' +
        '<span class="badge badge-code-' + train.code[0].toLowerCase() + '">' + escapeHtml(train.code) + '</span></div>';

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
          var color = colors[(o.id.charCodeAt(o.id.length - 1) + idx) % colors.length];
          html += '<div class="seat-seg" style="left:' + left + '%;width:' + width + '%;background:' + color + ';"' +
            ' data-tip="' + escapeHtml(p ? p.name : '未知') + '：' + escapeHtml(f ? f.nameZh : '') + ' → ' + escapeHtml(t ? t.nameZh : '') + '">' +
            escapeHtml(f ? f.nameZh : '') + '→' + escapeHtml(t ? t.nameZh : '') + '</div>';
        });
        html += '</div></div>';
      }
    });

    box.innerHTML = html || emptyState('暂无已出票订单');
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
    renderPassengers();
    refreshTrainStationSelect();
    renderTrainDraft();
    renderTrains();
    renderBooking();
    renderOrders();
    renderSeatMap();
  }

  /* ================= 导出 ================= */

  global.UI = {
    toast: toast,
    bindAll: function () {
      bindTabs();
      bindStationForm();
      bindStationDelete();
      bindPassengerForm();
      bindPassengerDelete();
      bindTrainForm();
      bindTrainDelete();
      bindBookingForm();
    },
    renderAll: renderAll,
    switchTab: switchTab
  };
})(window);
