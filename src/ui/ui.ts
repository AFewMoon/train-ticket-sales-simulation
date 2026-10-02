/* UI 层：五面板渲染、下拉联动、座位区间图、表单事件绑定、toast 反馈。
   只做 DOM 与事件；业务规则全部经应用层（booking/simulation），渲染数据为 ViewModel。
   渲染兜底保留 safe 语义：关联实体缺失/下标越界显示占位文案，绝不输出 undefined/NaN（教训 #22/#23）。 */

import type { Container } from '../container';
import { APP_VERSION } from '../version';
import { OrderStatus } from '../domain/model/order';
import { EVENT_META, isEventType, UNKNOWN_EVENT_META } from '../domain/model/event';
import { isValidSegment } from '../domain/model/seat-segment';
import { AUTO_LINE_ID, TYPE_META, typeOfTrain, type SimulationResult } from '../application/simulation-service';
import type { SimType } from '../domain/model/train';
import type {
  LineDraft,
  QueryState,
  SimSummaryState,
  TrainDraft
} from './app-state';
import type { TrainSeatMapModel } from '../application/view-models';
import { renderTrainSeatMaps } from './seat-map-canvas';
import { buildSimHash, parseSimHash, type SimLinkParams } from './sim-link';

/** 容器由 main.ts 在存储就绪后注入（initUi）。模块顶层禁止取容器——
    单文件 IIFE 中动态 import 不会推迟模块求值，顶层取容器会在 IndexedDB
    镜像预热前创建出 localStorage 回退容器（教训 #32）。 */
let c: Container;

/** 注入组合根容器：任何渲染/事件绑定发生前必须先调用 */
export function initUi(container: Container): void {
  c = container;
  // 页脚版本展示（file:// 直开时肉眼可辨当前构建版本）
  const el = document.getElementById('app-version');
  if (el) el.textContent = `v${APP_VERSION}`;
}

/* ================= DOM 工具 ================= */

/** 页面 DOM 面均为表单元素与容器的交集：统一按 HTMLInputElement 取型，
    覆盖 value / disabled / hidden / innerHTML / textContent 属性面 */
function $(sel: string): HTMLInputElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error('缺少 DOM 节点：' + sel);
  return el as HTMLInputElement;
}

function text(sel: string, content: string): void {
  $(sel).textContent = content;
}

function closestTarget(e: Event, selector: string): HTMLElement | null {
  const t = e.target;
  return t instanceof Element ? (t.closest(selector) as HTMLElement | null) : null;
}

/* ================= 视图状态 ================= */

const trainDraft: TrainDraft = { stationSeq: [] };
const lineDraft: LineDraft = { stationSeq: [], majorNos: [] };
const queryState: QueryState = { trainCode: '', segIdx: -1, segTrainCode: '' };
let lastSimSummary: SimSummaryState | null = null;
let lastBookingTrainCode: string | null = null;

/* ================= Toast ================= */

export function toast(msg: string, type?: string): void {
  const box = $('#toast-box');
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'info');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => {
      el.remove();
    }, 260);
  }, 2600);
}

/* ================= 通用渲染 ================= */

function emptyState(text: string): string {
  return (
    '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<path d="M3 7h13v10H3zM16 10h3l2 3v4h-5M6.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>' +
    '<div>' +
    escapeHtml(text) +
    '</div></div>'
  );
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

function confirmAction(msg: string): boolean {
  return window.confirm(msg);
}

/* ================= 车站面板 ================= */

function renderStations(): void {
  const stations = c.stations.list();
  text('#station-count', stations.length + ' 座');
  const wrap = $('#station-table-wrap');
  if (!stations.length) {
    wrap.innerHTML = emptyState('暂无车站，请在左侧登记');
    return;
  }
  const rows = stations
    .map(
      (s) =>
        '<tr><td><strong>' +
        escapeHtml(s.no) +
        '</strong></td><td>' +
        escapeHtml(s.nameZh) +
        '</td><td>' +
        escapeHtml(s.nameEn) +
        '</td><td><button class="btn btn-danger" data-del-station="' +
        escapeHtml(s.no) +
        '">删除</button></td></tr>'
    )
    .join('');
  wrap.innerHTML =
    '<table><thead><tr><th>号码</th><th>中文名</th><th>英文名</th><th>操作</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>';
}

function bindStationForm(): void {
  $('#station-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const zh = $('#station-name-zh').value;
    const en = $('#station-name-en').value;
    const res = c.stations.add(zh, en);
    if (!res.ok) {
      toast(res.msg, 'error');
      return;
    }
    toast('车站登记成功，号码：' + res.value.no, 'success');
    $('#station-name-zh').value = '';
    $('#station-name-en').value = '';
    renderAll();
  });
}

function bindStationDelete(): void {
  $('#station-table-wrap').addEventListener('click', (e) => {
    const btn = closestTarget(e, '[data-del-station]');
    if (!btn) return;
    const no = btn.getAttribute('data-del-station') ?? '';
    const s = c.stations.get(no);
    if (!confirmAction('确认删除车站「' + (s ? s.nameZh : no) + '」（' + no + '）？')) return;
    const res = c.stations.remove(no);
    toast(res.ok ? '车站已删除' : res.msg, res.ok ? 'success' : 'error');
    renderAll();
  });
}

/* ================= 线路面板 ================= */

function stationName(no: string | undefined): string {
  if (!no) return '未知站';
  const s = c.stations.get(no);
  return s ? s.nameZh : no;
}

function isMajorInDraft(no: string): boolean {
  return lineDraft.majorNos.indexOf(no) !== -1;
}

function renderLines(): void {
  const lines = c.lines.list();
  text('#line-count', lines.length + ' 条');
  const wrap = $('#line-table-wrap');
  if (!lines.length) {
    wrap.innerHTML = emptyState('暂无线路，可在左侧登记');
    return;
  }
  const rows = lines
    .map((l) => {
      const refCount = c.trains.list().filter((t) => t.lineId === l.id).length;
      const seqHtml = l.stationSeq
        .map((no, i) => {
          const major = (l.majorNos ?? []).indexOf(no) !== -1;
          return (
            (i > 0 ? '<span class="chain-arrow">→</span>' : '') +
            '<span class="chain-node' +
            (major ? ' is-major' : '') +
            '">' +
            escapeHtml(stationName(no)) +
            (major ? ' ★' : '') +
            '</span>'
          );
        })
        .join('');
      return (
        '<tr><td>' +
        escapeHtml(l.name) +
        (l.builtin ? ' <span class="badge badge-major">内置</span>' : '') +
        '</td><td>' +
        seqHtml +
        '</td><td>' +
        refCount +
        ' 列' +
        '</td><td><button class="btn btn-danger" data-del-line="' +
        escapeHtml(l.id) +
        '">删除</button></td></tr>'
      );
    })
    .join('');
  wrap.innerHTML =
    '<table><thead><tr><th>线路</th><th>站序（★ 大站）</th><th>挂接车次</th><th>操作</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>';
}

function refreshLineStationSelect(): void {
  const sel = $('#line-station-select');
  const stations = c.stations.list();
  const inDraft = new Set<string>(lineDraft.stationSeq);
  const options = stations
    .filter((s) => !inDraft.has(s.no))
    .map(
      (s) =>
        '<option value="' +
        escapeHtml(s.no) +
        '">' +
        escapeHtml(s.nameZh) +
        '（' +
        escapeHtml(s.no) +
        '）</option>'
    )
    .join('');
  sel.innerHTML = options || '<option value="">无可用车站</option>';
}

function renderLineDraft(): void {
  const chain = $('#line-station-chain');
  if (!lineDraft.stationSeq.length) {
    chain.innerHTML = '<span class="hint">尚未选择车站，请先在「车站」页登记</span>';
    return;
  }
  const html = lineDraft.stationSeq
    .map((no, i) => {
      const major = isMajorInDraft(no);
      const node =
        '<span class="chain-node' +
        (major ? ' is-major' : '') +
        '"><span class="idx">' +
        (i + 1) +
        '</span>' +
        escapeHtml(stationName(no)) +
        '<button type="button" class="chain-star' +
        (major ? ' is-on' : '') +
        '" data-toggle-major="' +
        i +
        '" title="标记/取消大站">' +
        (major ? '★' : '☆') +
        '</button>' +
        '<button type="button" class="chain-remove" data-remove-line-draft="' +
        i +
        '" title="移除">✕</button></span>';
      return (i > 0 ? '<span class="chain-arrow">→</span>' : '') + node;
    })
    .join('');
  chain.innerHTML = html;
}

function bindLineForm(): void {
  $('#add-line-station').addEventListener('click', () => {
    const no = $('#line-station-select').value;
    if (!no) {
      toast('无可用车站可选', 'error');
      return;
    }
    lineDraft.stationSeq.push(no);
    renderLineDraft();
    refreshLineStationSelect();
  });

  $('#line-station-chain').addEventListener('click', (e) => {
    const rm = closestTarget(e, '[data-remove-line-draft]');
    if (rm) {
      const idx = Number(rm.getAttribute('data-remove-line-draft'));
      const removed = lineDraft.stationSeq.splice(idx, 1)[0];
      lineDraft.majorNos = lineDraft.majorNos.filter((no) => no !== removed);
      renderLineDraft();
      refreshLineStationSelect();
      return;
    }
    const star = closestTarget(e, '[data-toggle-major]');
    if (star) {
      const i = Number(star.getAttribute('data-toggle-major'));
      const no = lineDraft.stationSeq[i];
      if (!no) return;
      const pos = lineDraft.majorNos.indexOf(no);
      if (pos === -1) lineDraft.majorNos.push(no);
      else lineDraft.majorNos.splice(pos, 1);
      renderLineDraft();
    }
  });

  $('#line-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const res = c.lines.add($('#line-name').value, lineDraft.stationSeq, lineDraft.majorNos.slice());
    if (!res.ok) {
      toast(res.msg, 'error');
      return;
    }
    toast(
      '线路登记成功：' +
        res.value.name +
        '（' +
        res.value.stationSeq.length +
        ' 站，大站 ' +
        res.value.majorNos.length +
        ' 个）',
      'success'
    );
    $('#line-name').value = '';
    lineDraft.stationSeq = [];
    lineDraft.majorNos = [];
    renderLineDraft();
    refreshLineStationSelect();
    renderAll();
  });
}

function bindLineDelete(): void {
  $('#line-table-wrap').addEventListener('click', (e) => {
    const btn = closestTarget(e, '[data-del-line]');
    if (!btn) return;
    const id = btn.getAttribute('data-del-line') ?? '';
    const l = c.lines.get(id);
    if (!confirmAction('确认删除线路「' + (l ? l.name : id) + '」？')) return;
    const res = c.lines.remove(id);
    toast(res.ok ? '线路已删除' : res.msg, res.ok ? 'success' : 'error');
    renderAll();
  });
}

/* ================= 车次面板 ================= */

function renderTrainDraft(): void {
  const chain = $('#train-station-chain');
  if (!trainDraft.stationSeq.length) {
    chain.innerHTML = '<span class="hint">尚未选择车站，请先在「车站」页登记</span>';
    return;
  }
  const html = trainDraft.stationSeq
    .map((no, i) => {
      const node =
        '<span class="chain-node"><span class="idx">' +
        (i + 1) +
        '</span>' +
        escapeHtml(stationName(no)) +
        '<button type="button" class="chain-remove" data-remove-draft="' +
        i +
        '" title="移除">✕</button></span>';
      return (i > 0 ? '<span class="chain-arrow">→</span>' : '') + node;
    })
    .join('');
  chain.innerHTML = html;
}

function renderTrains(): void {
  const trains = c.trains.list();
  text('#train-count', trains.length + ' 列');
  const wrap = $('#train-table-wrap');
  if (!trains.length) {
    wrap.innerHTML = emptyState('暂无车次，请在左侧登记');
    return;
  }
  const codeBadge = (code: string) => {
    const cls = 'badge-code-' + (code[0] ?? 'g').toLowerCase();
    return '<span class="badge ' + cls + '">' + escapeHtml(code) + '</span>';
  };
  const rows = trains
    .map((t) => {
      const line = t.lineId ? c.lines.get(t.lineId) : null;
      const lineBadge = line ? ' <span class="badge badge-count">' + escapeHtml(line.name) + '</span>' : '';
      const simBadge = t.sim ? ' <span class="badge badge-type-skip">仿真</span>' : '';
      const seqHtml = t.stationSeq
        .map((no, i) => {
          const name = stationName(no);
          const major = line ? (line.majorNos ?? []).indexOf(no ?? '') !== -1 : false;
          return (
            (i > 0 ? '<span class="chain-arrow">→</span>' : '') +
            '<span class="chain-node' +
            (major ? ' is-major" title="大站' : '"') +
            '">' +
            escapeHtml(name) +
            (major ? '★' : '') +
            '</span>'
          );
        })
        .join('');
      return (
        '<tr><td>' +
        codeBadge(t.code) +
        lineBadge +
        simBadge +
        '</td><td>' +
        seqHtml +
        '</td><td>' +
        t.seatCount +
        ' 座</td><td><button class="btn btn-danger" data-del-train="' +
        escapeHtml(t.code) +
        '">删除</button></td></tr>'
      );
    })
    .join('');
  wrap.innerHTML =
    '<table><thead><tr><th>车次</th><th>站序</th><th>座位数</th><th>操作</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>';
}

function refreshTrainLineSelect(): void {
  const sel = $('#train-line');
  const lines = c.lines.list();
  const prev = sel.value;
  sel.innerHTML =
    '<option value="">不挂接线路</option>' +
    lines
      .map(
        (l) =>
          '<option value="' +
          escapeHtml(l.id) +
          '">' +
          escapeHtml(l.name) +
          '（' +
          l.stationSeq.length +
          ' 站）</option>'
      )
      .join('');
  if (prev && lines.some((l) => l.id === prev)) sel.value = prev;
}

function refreshTrainStationSelect(): void {
  const sel = $('#train-station-select');
  const lineId = $('#train-line').value;
  const line = lineId ? c.lines.get(lineId) : null;
  const inDraft = new Set<string>(trainDraft.stationSeq);

  let candidates: string[];
  if (line) {
    // 挂线：候选 = 线路站序中最后一个已选站之后的站（随路线成形单调收缩）
    let lastIdx = -1;
    trainDraft.stationSeq.forEach((no) => {
      const idx = line.stationSeq.indexOf(no);
      if (idx > lastIdx) lastIdx = idx;
    });
    candidates = line.stationSeq.slice(lastIdx + 1).filter((no) => !inDraft.has(no));
  } else {
    candidates = c.stations
      .list()
      .map((s) => s.no)
      .filter((no) => !inDraft.has(no));
  }
  const options = candidates
    .map(
      (no) =>
        '<option value="' +
        escapeHtml(no) +
        '">' +
        escapeHtml(stationName(no)) +
        '（' +
        escapeHtml(no) +
        '）</option>'
    )
    .join('');
  sel.innerHTML = options || '<option value="">无可用车站' + (line ? '——线路剩余站已选完' : '') + '</option>';
}

function bindTrainForm(): void {
  $('#add-train-station').addEventListener('click', () => {
    const no = $('#train-station-select').value;
    if (!no) {
      toast('无可用车站可选', 'error');
      return;
    }
    trainDraft.stationSeq.push(no);
    renderTrainDraft();
    refreshTrainStationSelect();
  });

  $('#train-station-chain').addEventListener('click', (e) => {
    const btn = closestTarget(e, '[data-remove-draft]');
    if (!btn) return;
    trainDraft.stationSeq.splice(Number(btn.getAttribute('data-remove-draft')), 1);
    renderTrainDraft();
    refreshTrainStationSelect();
  });

  $('#seat-minus').addEventListener('click', () => {
    const input = $('#train-seat-count');
    input.value = String(Math.max(1, (Number(input.value) || 1) - 1));
  });
  $('#seat-plus').addEventListener('click', () => {
    const input = $('#train-seat-count');
    input.value = String(Math.min(2147483647, (Number(input.value) || 1) + 1));
  });

  // 挂接线路变化时，途经站候选范围随路线成形收缩
  $('#train-line').addEventListener('change', refreshTrainStationSelect);

  $('#train-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const lineId = $('#train-line').value || null;
    const customCode = $('#train-code').value.trim();
    const res = c.trains.add(
      trainDraft.stationSeq,
      Number($('#train-seat-count').value),
      lineId,
      null,
      customCode
    );
    if (!res.ok) {
      toast(res.msg, 'error');
      return;
    }
    toast('车次登记成功：' + res.value.code, 'success');
    trainDraft.stationSeq = [];
    $('#train-seat-count').value = '5';
    $('#train-code').value = '';
    renderTrainDraft();
    refreshTrainStationSelect();
    renderAll();
  });
}

function bindTrainDelete(): void {
  $('#train-table-wrap').addEventListener('click', (e) => {
    const btn = closestTarget(e, '[data-del-train]');
    if (!btn) return;
    const code = btn.getAttribute('data-del-train') ?? '';
    if (!confirmAction('确认删除车次 ' + code + '？')) return;
    const res = c.trains.remove(code);
    toast(res.ok ? '车次已删除' : res.msg, res.ok ? 'success' : 'error');
    renderAll();
  });
}

/* ================= 购票面板 ================= */

function renderBooking(): void {
  // 车次下拉
  const tSel = $('#booking-train');
  const trains = c.trains.list();
  const prevT = tSel.value;
  tSel.innerHTML = trains.length
    ? trains
        .map((t) => '<option value="' + escapeHtml(t.code) + '">' + escapeHtml(t.code) + '</option>')
        .join('')
    : '<option value="">请先登记车次</option>';
  if (prevT && trains.some((t) => t.code === prevT)) tSel.value = prevT;

  renderCapacityHint();
  renderRangeSelects();
  renderWaitingList();
}

function renderCapacityHint(): void {
  const hint = $('#booking-capacity');
  const view = c.booking.capacityHint($('#booking-train').value);
  hint.textContent = view.text;
}

/** 起点/终点联动：起点下拉展示全部站序；终点仅展示起点之后的站。
    prev 下标只在车次未变时恢复，避免跨车次的站序错位（教训 #23） */
function renderRangeSelects(): void {
  const code = $('#booking-train').value;
  const train = code ? c.trains.get(code) : null;
  const fromSel = $('#booking-from');
  const toSel = $('#booking-to');
  if (!train) {
    lastBookingTrainCode = null;
    fromSel.innerHTML = '<option value="">—</option>';
    toSel.innerHTML = '<option value="">—</option>';
    toSel.disabled = true;
    return;
  }
  toSel.disabled = false;
  const sameTrain = lastBookingTrainCode === code;
  lastBookingTrainCode = code;
  const prevFrom = fromSel.value;
  fromSel.innerHTML = train.stationSeq
    .map((no, i) => '<option value="' + i + '">' + escapeHtml(stationName(no)) + '</option>')
    .join('');
  if (sameTrain && prevFrom !== '' && Number(prevFrom) < train.stationSeq.length) fromSel.value = prevFrom;
  renderToOptions(sameTrain);
}

function renderToOptions(sameTrain: boolean): void {
  const code = $('#booking-train').value;
  const train = code ? c.trains.get(code) : null;
  if (!train) return;
  const fromIdx = Number($('#booking-from').value) || 0;
  const toSel = $('#booking-to');
  const prevTo = toSel.value;
  let options = '';
  for (let i = fromIdx + 1; i < train.stationSeq.length; i++) {
    const no = train.stationSeq[i];
    options += '<option value="' + i + '">' + escapeHtml(stationName(no)) + '</option>';
  }
  toSel.innerHTML = options || '<option value="">无合法终点</option>';
  if (sameTrain && prevTo && Number(prevTo) > fromIdx && Number(prevTo) < train.stationSeq.length) {
    toSel.value = prevTo;
  }
}

function renderWaitingList(): void {
  const waiting = c.booking.waitingList();
  const box = $('#waiting-list');
  if (!waiting.length) {
    box.innerHTML = emptyState('当前没有候补订单');
    return;
  }
  const html = waiting
    .map(
      (w) =>
        '<div class="waiting-item"><span>' +
        escapeHtml(w.trainCode) +
        ' · ' +
        escapeHtml(w.fromLabel) +
        ' → ' +
        escapeHtml(w.toLabel) +
        '</span><span class="pos">候补第 ' +
        w.position +
        ' 位</span></div>'
    )
    .join('');
  box.innerHTML = html;
}

function bindBookingForm(): void {
  $('#booking-train').addEventListener('change', () => {
    renderCapacityHint();
    renderRangeSelects();
  });
  $('#booking-from').addEventListener('change', () => {
    renderToOptions(true);
  });

  $('#booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#booking-train').value;
    const fromIdx = Number($('#booking-from').value);
    const toIdx = Number($('#booking-to').value);
    if (!code) {
      toast('请先登记车次', 'error');
      return;
    }
    if (isNaN(fromIdx) || isNaN(toIdx) || !isValidSegment(fromIdx, toIdx)) {
      toast('请选择合法乘车区间', 'error');
      return;
    }
    try {
      const res = await c.booking.purchase(code, fromIdx, toIdx);
      if (!res.ok) {
        toast(res.msg, 'error');
        return;
      }
      if (res.issued) {
        toast('出票成功！座位号：' + res.seatNo, 'success');
      } else {
        toast('暂无合适组合，订单进入候补等待（第 ' + res.position + ' 位）', 'info');
      }
    } catch (err) {
      toast('购票失败：' + (err instanceof Error ? err.message : String(err)), 'error');
      return;
    }
    renderAll();
  });
}

/* ================= 订单与座位面板 ================= */

function renderOrders(): void {
  const orders = c.booking.orderRows();
  text('#order-count', orders.length + ' 单');
  const wrap = $('#order-table-wrap');
  if (!orders.length) {
    wrap.innerHTML = emptyState('暂无订单，请前往「购票」页下单');
    return;
  }
  const rows = orders
    .map((o) => {
      const status =
        o.status === OrderStatus.ISSUED
          ? '<span class="badge badge-issued">已出票</span>'
          : o.status === OrderStatus.CANCELLED
            ? '<span class="badge badge-cancelled">已取消</span>'
            : '<span class="badge badge-waiting">候补中</span>';
      const op = o.refundable
        ? '<button class="btn btn-danger" data-refund-order="' + escapeHtml(o.id) + '">' + escapeHtml(o.refundLabel) + '</button>'
        : '—';
      return (
        '<tr><td>' +
        escapeHtml(o.trainCode) +
        '</td><td>' +
        escapeHtml(o.fromLabel) +
        ' → ' +
        escapeHtml(o.toLabel) +
        '</td><td>' +
        status +
        '</td><td>' +
        escapeHtml(o.seatLabel) +
        '</td><td>' +
        op +
        '</td></tr>'
      );
    })
    .join('');
  wrap.innerHTML =
    '<table><thead><tr><th>车次</th><th>区间</th><th>状态</th><th>座位</th><th>操作</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>';
}

function bindOrderRefund(): void {
  $('#order-table-wrap').addEventListener('click', async (e) => {
    const btn = closestTarget(e, '[data-refund-order]');
    if (!btn) return;
    const id = btn.getAttribute('data-refund-order') ?? '';
    if (!confirmAction('确认退票 / 取消该订单？座位区间将释放并自动触发候补兑现。')) return;
    try {
      const res = await c.booking.refundOrder(id);
      if (!res.ok) {
        toast(res.msg, 'error');
        return;
      }
      toast(res.fulfilled > 0 ? '退票成功，候补兑现 ' + res.fulfilled + ' 单' : '退票成功', 'success');
    } catch (err) {
      toast('退票失败：' + (err instanceof Error ? err.message : String(err)), 'error');
      return;
    }
    renderAll();
  });
}

/* ================= 事件时间线 ================= */

function relTime(ts: number): string {
  if (ts === undefined || ts === null || isNaN(new Date(ts).getTime())) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function renderEventLog(): void {
  const box = $('#event-timeline');
  const events = c.ticketing.listEvents(50);
  if (!events.length) {
    box.innerHTML = emptyState('暂无事件，购票 / 出票 / 退票后在此实时记录');
    return;
  }
  box.innerHTML = events
    .map((ev) => {
      // 未知事件类型（旧版数据残留等）显示占位文案，不输出 undefined（教训 #23）
      const meta = isEventType(ev.type) ? EVENT_META[ev.type] : UNKNOWN_EVENT_META;
      const train = ev.trainCode ? ' · ' + escapeHtml(ev.trainCode) : '';
      return (
        '<div class="ev-item ' +
        meta.cls +
        '">' +
        '<div class="ev-head"><span class="ev-badge">' +
        meta.label +
        '</span>' +
        '<span class="ev-time">' +
        relTime(ev.ts) +
        train +
        '</span></div>' +
        '<div class="ev-detail">' +
        escapeHtml(ev.detail ?? '') +
        '</div></div>'
      );
    })
    .join('');
}

/* ================= 座位区间图 =================

   渲染已迁移至 seat-map-canvas.ts：每个车次一张 Canvas，
   区间块用 ctx.fillRect 绘制，悬停 tooltip 由命中检测实现。 */

function renderSeatMap(): void {
  const box = $('#seat-map');
  const trains = c.trains.list();
  const anyIssued = c.ticketing.currentOrders().some((o) => o.status === OrderStatus.ISSUED);
  if (!trains.length || !anyIssued) {
    box.innerHTML = emptyState('暂无已出票订单，出票后可在此查看每个座位的区间拼接');
    return;
  }
  const models = c.booking.seatMaps();
  if (!models.length) {
    box.innerHTML = emptyState('暂无已出票订单');
    return;
  }
  renderTrainSeatMaps(box, models);
}

/* ================= 自动仿真面板 ================= */

function refreshSimLineSelect(): void {
  const sel = $('#sim-line');
  const lines = c.lines.list();
  const prev = sel.value;
  sel.innerHTML =
    lines
      .map(
        (l) =>
          '<option value="' +
          escapeHtml(l.id) +
          '">' +
          escapeHtml(l.name) +
          '（' +
          l.stationSeq.length +
          ' 站 · 大站 ' +
          (l.majorNos ?? []).length +
          '）</option>'
      )
      .join('') + '<option value="__auto__">＋ 自动生成模拟线路</option>';
  if (prev && (lines.some((l) => l.id === prev) || prev === AUTO_LINE_ID)) sel.value = prev;
  syncSimAutoField();
}

function syncSimAutoField(): void {
  $('#sim-auto-field').hidden = $('#sim-line').value !== AUTO_LINE_ID;
}

function statCard(label: string, value: string | number, cls?: string): string {
  return (
    '<div class="stat-card ' +
    (cls || '') +
    '"><div class="stat-label">' +
    label +
    '</div>' +
    '<div class="stat-value">' +
    value +
    '</div></div>'
  );
}

function renderSimResults(): void {
  if (!lastSimSummary) return;
  const s = lastSimSummary;

  // 统计卡片
  $('#sim-stats').innerHTML =
    statCard('总请求', s.totalRequests, 'is-blue') +
    statCard('已出票', s.totalIssued, 'is-green') +
    statCard('候补中', s.totalWaiting, 'is-amber') +
    statCard('出票率', s.issuedRate.toFixed(1) + '%', 'is-green') +
    statCard('运算时间', s.elapsedMs + ' ms', 'is-blue');

  // 每车次摘要表
  const rows = Object.keys(s.perTrain)
    .map((code) => {
      const st = s.perTrain[code];
      if (!st) return '';
      const tm = typeMetaOf(typeOfTrain(st.train));
      const stops = st.train.stationSeq.length;
      const majors = st.train.stationSeq.filter((no) => (s.summaryLineMajorNos ?? []).indexOf(no) !== -1).length;
      return (
        '<tr><td><strong>' +
        escapeHtml(code) +
        '</strong></td>' +
        '<td><span class="badge ' +
        (tm.typeBadge ?? 'badge-count') +
        '">' +
        escapeHtml(tm.typeName ?? '自定义') +
        '</span></td>' +
        '<td>' +
        st.train.seatCount +
        ' 座 / 停 ' +
        stops +
        ' 站（大站 ' +
        majors +
        '）</td>' +
        '<td>' +
        st.requests +
        '</td><td style="color:var(--green);font-weight:700;">' +
        st.issued +
        '</td>' +
        '<td style="color:#B45309;font-weight:700;">' +
        st.waiting +
        '</td></tr>'
      );
    })
    .join('');
  $('#sim-summary').innerHTML =
    '<table><thead><tr><th>车次</th><th>类型</th><th>运力</th><th>请求</th><th>出票</th><th>候补</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>';
  $('#sim-summary-card').hidden = false;

  // 按车次分组的座位图
  const models = s.trains
    .map((t) => c.booking.seatMapForTrain(t))
    .filter((m): m is TrainSeatMapModel => m !== null);
  const simBox = $('#sim-seatmap');
  if (!models.length) {
    simBox.innerHTML = emptyState('本次仿真无出票订单');
  } else {
    renderTrainSeatMaps(simBox, models);
  }
  $('#sim-seatmap-card').hidden = false;
}

function typeMetaOf(simType: SimType | null): { typeName: string | null; typeBadge: string | null } {
  if (simType === null) return { typeName: null, typeBadge: null };
  const meta = TYPE_META[simType];
  return meta ? { typeName: meta.label, typeBadge: meta.badge } : { typeName: null, typeBadge: null };
}

/** 仿真表单的读取口径（lineId 为下拉选中的线路 id，runSimulation 直接消费） */
interface SimFormValues {
  lineId: string;
  autoStationCount: number;
  countDirect: number;
  countExpress: number;
  countSkip: number;
  seats: number;
  requests: number;
  seed: number;
}

/** 读取仿真表单（submit 与复制链接共用，保证两处口径一致）。
    种子 0 是合法值，不可用 `||` 吞掉（同教训 #10 族：类型/语义陷阱） */
function readSimForm(): SimFormValues {
  const seed = Number($('#sim-seed').value);
  return {
    lineId: $('#sim-line').value,
    autoStationCount: Number($('#sim-auto-stations').value) || 10,
    countDirect: Number($('#sim-count-direct').value) || 0,
    countExpress: Number($('#sim-count-express').value) || 0,
    countSkip: Number($('#sim-count-skip').value) || 0,
    seats: Number($('#sim-seats').value) || 4,
    requests: Number($('#sim-requests').value) || 10,
    seed: Number.isFinite(seed) ? Math.floor(seed) : -1
  };
}

/** 表单口径 → 链接口径：线路 id 换成名称（id 由 uid() 生成、跨机器不稳定）。
    线路已不存在时编码原 id，由解析端按「实体存在性校验」降级提示 */
function toLinkParams(f: SimFormValues): SimLinkParams {
  return {
    line: f.lineId === AUTO_LINE_ID ? AUTO_LINE_ID : c.lines.list().find((l) => l.id === f.lineId)?.name ?? f.lineId,
    autoStationCount: f.autoStationCount,
    countDirect: f.countDirect,
    countExpress: f.countExpress,
    countSkip: f.countSkip,
    seats: f.seats,
    requests: f.requests,
    seed: f.seed
  };
}

/** 把 hash 段写入地址栏（同文档替换，不产生历史记录） */
function syncSimHash(f: SimFormValues): void {
  try {
    history.replaceState(null, '', buildSimHash(toLinkParams(f)));
  } catch {
    /* file:// 个别环境可能受限，静默降级：链接复制仍可用完整 href */
  }
}

/** 剪贴板写入：clipboard API 优先，execCommand 降级（file:// 下可能无异步剪贴板权限） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 启动回填：解析 URL hash 中的仿真参数并填入表单（只回填不运行——
    仿真会写入持久化数据，静默执行违背用户预期）。
    线路按名称反查 id（id 由 uid() 生成跨机器不稳定，教训 #23：恢复前校验实体存在性），
    本机不存在同名线路时保留当前选择并提示。 */
export function applySimParamsFromHash(): void {
  const p = parseSimHash(location.hash);
  if (!p) return;
  let lineValue = '';
  if (p.line === AUTO_LINE_ID) {
    lineValue = AUTO_LINE_ID;
  } else {
    lineValue = c.lines.list().find((l) => l.name === p.line)?.id ?? '';
  }
  if (!lineValue) {
    toast('链接中的线路「' + p.line + '」在本机不存在，已保留当前选择', 'error');
  }
  $('#sim-auto-stations').value = String(p.autoStationCount);
  $('#sim-count-direct').value = String(p.countDirect);
  $('#sim-count-express').value = String(p.countExpress);
  $('#sim-count-skip').value = String(p.countSkip);
  $('#sim-seats').value = String(p.seats);
  $('#sim-requests').value = String(p.requests);
  $('#sim-seed').value = String(p.seed);
  if (lineValue) $('#sim-line').value = lineValue;
  syncSimAutoField();
  toast('已从链接载入仿真参数（种子 ' + p.seed + '），点击「运行仿真」复现', 'success');
}

function bindSimForm(): void {
  $('#sim-line').addEventListener('change', syncSimAutoField);

  $('#sim-copy-link').addEventListener('click', async () => {
    const url = location.href.split('#')[0] + buildSimHash(toLinkParams(readSimForm()));
    const ok = await copyText(url);
    if (ok) {
      toast('复现链接已复制：在别处打开后点击「运行仿真」即可同种子复现', 'success');
    } else {
      toast('复制失败，请手动复制地址栏链接', 'error');
    }
  });

  $('#sim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let res: SimulationResult;
    try {
      res = await c.booking.runSimulation(readSimForm());
    } catch (err) {
      toast('仿真失败：' + (err instanceof Error ? err.message : String(err)), 'error');
      return;
    }
    if (!res.ok) {
      toast(res.msg, 'error');
      return;
    }
    // 提供线路大站集合供摘要表标注
    lastSimSummary = {
      ...res.summary,
      summaryLineMajorNos: res.summary.line.majorNos ?? []
    };
    // 随机种子（-1）回显实际使用的种子，便于复现
    $('#sim-seed').value = String(res.summary.usedSeed);
    // 运行成功即把实际生效参数写入地址栏 hash（跑完即得可复现链接）
    syncSimHash(readSimForm());
    renderSimResults();
    toast(
      '仿真完成（种子 ' +
        res.summary.usedSeed +
        '，耗时 ' +
        res.summary.elapsedMs +
        ' ms）: ' +
        res.summary.totalRequests +
        ' 次请求，出票 ' +
        res.summary.totalIssued +
        '，候补 ' +
        res.summary.totalWaiting,
      'success'
    );
    renderAll();
  });

  $('#sim-cleanup').addEventListener('click', () => {
    if (!confirmAction('确认清理全部仿真数据（sim 标记的线路/车次/订单与自动生成的模拟车站）？手动登记的数据不受影响。'))
      return;
    c.simulation.cleanupSimulation();
    lastSimSummary = null;
    $('#sim-stats').innerHTML = '<div class="empty-state">仿真数据已清理，可重新配置参数运行</div>';
    $('#sim-summary-card').hidden = true;
    $('#sim-seatmap-card').hidden = true;
    toast('仿真数据已清理', 'success');
    renderAll();
  });
}

/* ================= 数据查询区 ================= */

function renderQueryArea(): void {
  const trains = c.trains.list();
  const tSel = $('#query-train');
  const sSel = $('#query-segment');
  if (!trains.some((t) => t.code === queryState.trainCode)) {
    queryState.trainCode = trains.length ? (trains[0]?.code ?? '') : '';
    queryState.segIdx = -1;
  }
  tSel.innerHTML = trains.length
    ? trains
        .map((t) => '<option value="' + escapeHtml(t.code) + '">' + escapeHtml(t.code) + '</option>')
        .join('')
    : '<option value="">无车次</option>';
  tSel.value = queryState.trainCode;

  const train = c.trains.get(queryState.trainCode);
  if (train) {
    // 段下标只在车次未变时恢复，避免跨车次的段选择错位（教训 #23）
    const sameQueryTrain = queryState.segTrainCode === queryState.trainCode;
    const prevSeg = sameQueryTrain ? queryState.segIdx : -1;
    let opts = '<option value="-1">全部订单</option>';
    for (let i = 0; i < train.stationSeq.length - 1; i++) {
      const f = stationName(train.stationSeq[i]);
      const t2 = stationName(train.stationSeq[i + 1]);
      opts += '<option value="' + i + '">' + escapeHtml(f) + '—' + escapeHtml(t2) + ' 段</option>';
    }
    sSel.innerHTML = opts;
    const clamped = prevSeg >= -1 && prevSeg < train.stationSeq.length - 1 ? prevSeg : -1;
    sSel.value = String(clamped);
    sSel.disabled = false;
    queryState.segTrainCode = queryState.trainCode;
  } else {
    sSel.innerHTML = '<option value="-1">—</option>';
    sSel.disabled = true;
  }
  renderQueryResult();
}

function renderQueryResult(): void {
  const box = $('#query-result');
  const view = c.booking.queryResult(queryState.trainCode, queryState.segIdx);

  if (view.kind === 'no-train') {
    box.innerHTML = emptyState('暂无车次数据');
    return;
  }

  if (view.kind === 'all') {
    if (!view.rows.length) {
      box.innerHTML = emptyState('该车次暂无订单');
      return;
    }
    const rows = view.rows
      .map(
        (r) =>
          '<tr><td>' +
          escapeHtml(r.fromLabel) +
          ' → ' +
          escapeHtml(r.toLabel) +
          '</td>' +
          '<td>' +
          statusBadge(r.status) +
          '</td>' +
          '<td>' +
          escapeHtml(r.seatLabel) +
          '</td></tr>'
      )
      .join('');
    box.innerHTML =
      '<table><thead><tr><th>区间</th><th>状态</th><th>座位</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>';
    return;
  }

  // 指定相邻区间段上的已出票订单
  const title = escapeHtml(view.title);
  if (!view.rows.length) {
    box.innerHTML = emptyState(title + '：本段暂无已出票订单');
    return;
  }
  const rows = view.rows
    .map(
      (r) =>
        '<tr><td>' +
        escapeHtml(r.fromLabel) +
        ' → ' +
        escapeHtml(r.toLabel) +
        '</td>' +
        '<td>' +
        escapeHtml(r.seatLabel) +
        '</td></tr>'
    )
    .join('');
  box.innerHTML =
    '<p class="hint" style="margin: 4px 0 8px;">' +
    title +
    '：共 ' +
    view.rows.length +
    ' 张票</p>' +
    '<table><thead><tr><th>完整旅程</th><th>座位</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>';
}

function statusBadge(status: OrderStatus): string {
  if (status === OrderStatus.ISSUED) return '<span class="badge badge-issued">已出票</span>';
  if (status === OrderStatus.CANCELLED) return '<span class="badge badge-cancelled">已取消</span>';
  return '<span class="badge badge-waiting">候补中</span>';
}

function bindQueryControls(): void {
  $('#query-train').addEventListener('change', function (this: HTMLSelectElement) {
    queryState.trainCode = this.value;
    queryState.segIdx = -1;
    renderQueryArea();
  });
  $('#query-segment').addEventListener('change', function (this: HTMLSelectElement) {
    queryState.segIdx = Number(this.value);
    renderQueryResult();
  });
}

/* ================= 退票模拟（业务已下沉至 BookingAppService.refundSimulation） ================= */

function bindRefundSim(): void {
  $('#refund-sim-btn').addEventListener('click', async () => {
    const rate = Number($('#refund-rate').value);
    if (!isFinite(rate) || rate < 1 || rate > 100) {
      toast('退票比率需在 1-100 之间', 'error');
      return;
    }
    if (!c.booking.hasIssuedOrders()) {
      toast('当前没有已出票订单', 'info');
      return;
    }
    try {
      const res = await c.booking.refundSimulation(rate);
      if (!res.ok) {
        toast(res.msg, 'error');
        return;
      }
      toast('退票模拟：退 ' + res.refunded + ' 张，候补补录 ' + res.fulfilled + ' 单', 'success');
    } catch (err) {
      toast('退票模拟失败：' + (err instanceof Error ? err.message : String(err)), 'error');
      return;
    }
    renderAll();
  });
}

/* ================= 标签切换 ================= */

export function switchTab(name: string): void {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.getAttribute('data-tab') === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach((p) => {
    const active = p.id === 'panel-' + name;
    p.classList.toggle('is-active', active);
    (p as HTMLElement).hidden = !active;
  });
  renderAll();
}

function bindTabs(): void {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab') ?? '');
    });
  });
}

/* ================= 汇总渲染 ================= */

export function renderAll(): void {
  renderStations();
  renderLines();
  refreshLineStationSelect();
  renderLineDraft();
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

export function bindAll(): void {
  bindTabs();
  bindStationForm();
  bindStationDelete();
  bindLineForm();
  bindLineDelete();
  bindTrainForm();
  bindTrainDelete();
  bindBookingForm();
  bindOrderRefund();
  bindQueryControls();
  bindRefundSim();
  bindSimForm();
}
