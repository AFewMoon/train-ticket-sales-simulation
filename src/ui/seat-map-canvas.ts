/* 座位区间图 Canvas 渲染器：座位行（fillRect 彩色区间块）+ 停站轴全部绘制在 Canvas 内。
   数据源仍为应用层 ViewModel（TrainSeatMapModel），几何（leftPct/widthPct）由
   BookingAppService 计算，本模块只做绘制与悬停命中检测（教训 #22：站名已含兜底，不再查实体）。 */

import type { TrainSeatMapModel } from '../application/view-models';

/* ---------- 调色板与取色（与旧 DOM 版同一规则，保证色彩一致） ---------- */

const SEG_COLORS = ['#2563EB', '#16A34A', '#F59E0B', '#DC2626', '#7C3AED', '#0891B2', '#DB2777', '#65A30D'];

function segColor(orderId: string, segIndex: number): string {
  const idx = (orderId.charCodeAt(orderId.length - 1) + segIndex) % SEG_COLORS.length;
  return SEG_COLORS[idx] ?? SEG_COLORS[0] ?? '#2563EB';
}

/* ---------- 布局常量（对齐旧 DOM 版视觉规格） ---------- */

const LABEL_W = 96; // 「座位 N」标签列宽（旧 .seat-row 网格列）
const GAP = 12; // 标签列与轨道间距
const TRACK_H = 34; // 轨道高（旧 .seat-track height）
const ROW_H = TRACK_H + 8; // 行距
const AXIS_H = 24; // 停站轴高度
const FONT = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
const COLOR_TRACK_BG = '#F8FAFC';
const COLOR_TRACK_BORDER = '#E2E8F0'; // --line
const COLOR_LABEL_BG = '#DBEAFE'; // --primary-100
const COLOR_LABEL_FG = '#1D4ED8'; // --primary-700
const COLOR_AXIS = '#94A3B8'; // --text-3

/* ---------- HTML 工具 ---------- */

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

/* ---------- 绘制 ---------- */

interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
  tip: string;
}

/** 圆角矩形路径（roundRect 不可用时退化为直角） */
function traceRect(
  ctx: CanvasRenderingContext2D | CanvasRenderingContext2D & { roundRect?: unknown },
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  if (typeof (ctx as { roundRect?: unknown }).roundRect === 'function') {
    (ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/** 绘制单趟车次座位图到 canvas，并登记悬停命中矩形 */
function drawTrain(canvas: HTMLCanvasElement, model: TrainSeatMapModel): HitRect[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  const S = model.stationCount;
  const trackW = Math.max(560, S * 72); // 内轨最小宽度：站点多时按站数展宽（旧 innerMinWidth 语义）
  const trackX = LABEL_W + GAP;
  const logicalW = trackX + trackW;
  const logicalH = model.rows.length * ROW_H + AXIS_H;

  // 高分屏适配：物理像素 × dpr，坐标系还原为逻辑像素
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(logicalW * dpr);
  canvas.height = Math.round(logicalH * dpr);
  canvas.style.width = logicalW + 'px';
  canvas.style.height = logicalH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle';

  const hitRects: HitRect[] = [];

  // 仅渲染已占用座位（座位数上限 INT_MAX，复杂度只与真实数据量相关，教训 #20）
  model.rows.forEach((row, rowIdx) => {
    const y0 = rowIdx * ROW_H;

    // 左侧「座位 N」标签
    traceRect(ctx, 0, y0, LABEL_W, TRACK_H, 8);
    ctx.fillStyle = COLOR_LABEL_BG;
    ctx.fill();
    ctx.font = '700 13px ' + FONT;
    ctx.fillStyle = COLOR_LABEL_FG;
    ctx.textAlign = 'center';
    ctx.fillText('座位 ' + row.seatNo, LABEL_W / 2, y0 + TRACK_H / 2);

    // 轨道底
    traceRect(ctx, trackX, y0, trackW, TRACK_H, 8);
    ctx.fillStyle = COLOR_TRACK_BG;
    ctx.fill();
    ctx.strokeStyle = COLOR_TRACK_BORDER;
    ctx.lineWidth = 1;
    ctx.stroke();

    // 彩色区间块：leftPct/widthPct → 轨道内像素，ctx.fillRect 绘制
    row.segs.forEach((seg) => {
      const x = trackX + (seg.leftPct / 100) * trackW;
      const w = (seg.widthPct / 100) * trackW;
      if (w <= 0) return;
      const sy = y0 + 4;
      const sh = TRACK_H - 8;
      traceRect(ctx, x, sy, w, sh, 6);
      ctx.fillStyle = segColor(seg.orderId, seg.segIndex);
      ctx.fill();
      // 内嵌底部阴影线（旧 box-shadow: inset 0 -1px 0 观感）
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(x, sy + sh - 1, w, 1);

      // 段内「起点→终点」白字：宽度足够才绘制，避免窄块文字溢出
      const label = seg.fromLabel + '→' + seg.toLabel;
      ctx.font = '600 11px ' + FONT;
      if (ctx.measureText(label).width <= w - 8) {
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(label, x + w / 2, sy + sh / 2);
      }

      hitRects.push({ x, y: sy, w, h: sh, tip: seg.fromLabel + ' → ' + seg.toLabel });
    });
  });

  // 停站轴：首站左对齐、末站右对齐、中间居中（大站带 ★，由 ViewModel label 携带）
  const axisY = model.rows.length * ROW_H + AXIS_H / 2;
  ctx.font = '10px ' + FONT;
  ctx.fillStyle = COLOR_AXIS;
  model.axis.forEach((tick, i) => {
    if (i === 0) {
      ctx.textAlign = 'left';
      ctx.fillText(tick.label, trackX, axisY);
    } else if (i === model.axis.length - 1) {
      ctx.textAlign = 'right';
      ctx.fillText(tick.label, trackX + trackW, axisY);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(tick.label, trackX + (parseFloat(tick.align) / 100) * trackW, axisY);
    }
  });

  return hitRects;
}

/* ---------- 悬停 tooltip（命中检测实现，替代旧 data-tip + ::after） ---------- */

function attachTooltip(canvas: HTMLCanvasElement, hitRects: HitRect[]): void {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const tip = document.createElement('div');
  tip.className = 'seat-tip';
  tip.hidden = true;
  wrap.appendChild(tip);

  const hide = (): void => {
    tip.hidden = true;
  };

  canvas.addEventListener('mousemove', (e) => {
    const x = e.offsetX;
    const y = e.offsetY;
    // 命中检测：自上而下最后一个覆盖该点的矩形优先（后绘制者在上层）
    let hit: HitRect | null = null;
    for (let i = hitRects.length - 1; i >= 0; i--) {
      const r = hitRects[i];
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        hit = r;
        break;
      }
    }
    if (!hit) {
      hide();
      return;
    }
    tip.textContent = hit.tip;
    tip.hidden = false;
    // 跟随鼠标，块下方 8px；越界时简单回拉
    tip.style.left = Math.min(x + 8, canvas.clientWidth - 140) + 'px';
    tip.style.top = y + 24 + 'px';
  });
  canvas.addEventListener('mouseleave', hide);
}

/* ---------- 对外入口 ---------- */

/** 车次头部徽章行（车次号 / 性质 / 线路）保持 HTML，座位行与停站轴移入 Canvas */
function buildTrainBlock(model: TrainSeatMapModel): HTMLElement {
  const item = document.createElement('div');
  item.className = 'seat-train';

  let head =
    '<div style="font-weight:700;color:var(--text-2);font-size:13px;">' +
    '<span class="badge badge-code-' +
    (model.code[0] ?? 'g').toLowerCase() +
    '">' +
    escapeHtml(model.code) +
    '</span>';
  if (model.typeName && model.typeBadge) {
    head += ' <span class="badge ' + escapeHtml(model.typeBadge) + '">' + escapeHtml(model.typeName) + '</span>';
  }
  if (model.lineName) {
    head += ' <span class="badge badge-count">' + escapeHtml(model.lineName) + '</span>';
  }
  head += '</div>';

  const headEl = document.createElement('div');
  headEl.innerHTML = head;
  item.appendChild(headEl);

  const scroll = document.createElement('div');
  scroll.className = 'seat-scroll';
  const inner = document.createElement('div');
  inner.className = 'seat-inner';
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'seat-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'seat-canvas';
  canvasWrap.appendChild(canvas);
  inner.appendChild(canvasWrap);
  scroll.appendChild(inner);
  item.appendChild(scroll);

  const hitRects = drawTrain(canvas, model);
  attachTooltip(canvas, hitRects);
  return item;
}

/** 渲染全部车次座位图（容器为 .seat-map，flex 纵向 + gap 由现有样式提供） */
export function renderTrainSeatMaps(container: HTMLElement, models: TrainSeatMapModel[]): void {
  container.innerHTML = '';
  models.forEach((model) => {
    container.appendChild(buildTrainBlock(model));
  });
}
