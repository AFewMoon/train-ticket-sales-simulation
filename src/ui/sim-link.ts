/* 自动仿真参数 ↔ URL hash 编解码（无 DOM 纯函数，可单测）。
   编码格式：#sim=line=<线路名|__auto__>&auto=<站数>&gd=<直达>&ge=<快车>&gs=<隔站>&seats=<座位>&req=<请求>&seed=<种子>
   - 线路按「名称」编码而非 id：线路 id 由 uid()（时间戳+随机）生成、跨机器不稳定；
     内置线路中文名稳定，解析端按名称反查 id（教训 #23：恢复前校验实体存在性）。
   - 载体用 hash 而非 search：file:// 直开与 GitHub Pages 均可用、不触发重载、
     写入用 history.replaceState 不产生历史记录。
   - 复现边界：引擎核心随机为 mulberry32（同种子同参数可复现），车次号生成用
     Math.random（simulation-engine.ts 注释留档），链接复现的是统计结果与订单分布。 */

export interface SimLinkParams {
  /** 线路名称或 '__auto__'（自动生成模拟线路） */
  line: string;
  autoStationCount: number;
  countDirect: number;
  countExpress: number;
  countSkip: number;
  seats: number;
  requests: number;
  seed: number;
}

const INT32_MAX = 2147483647;

/** 表单 HTML 的默认值（缺省参数时的回退基准） */
const DEFAULTS = {
  autoStationCount: 10,
  countDirect: 2,
  countExpress: 2,
  countSkip: 2,
  seats: 4,
  requests: 10
} as const;

/** 各数值字段的合法区间（与表单 min/max 语义一致） */
const BOUNDS = {
  autoStationCount: [4, 30],
  countDirect: [0, INT32_MAX],
  countExpress: [0, INT32_MAX],
  countSkip: [0, INT32_MAX],
  seats: [1, INT32_MAX],
  requests: [1, INT32_MAX]
} as const;

/** 编码为 hash 串（'#sim=...'）。中文名经 URLSearchParams 转义 */
export function buildSimHash(p: SimLinkParams): string {
  const q = new URLSearchParams({
    line: p.line,
    auto: String(Math.floor(p.autoStationCount)),
    gd: String(Math.floor(p.countDirect)),
    ge: String(Math.floor(p.countExpress)),
    gs: String(Math.floor(p.countSkip)),
    seats: String(Math.floor(p.seats)),
    req: String(Math.floor(p.requests)),
    seed: String(Math.floor(p.seed))
  }).toString();
  return '#sim=' + q;
}

/**
 * 解析 hash 串为参数对象；无法安全回填时返回 null（整段忽略）。
 * - line 缺失/为空 → null；seed 缺失/非整数/超出 [-1, INT32_MAX] → null（种子是复现的根基，宁缺毋错）；
 * - 其余数值字段缺省用 DEFAULTS，越界钳制到 [min, max]。
 */
export function parseSimHash(hash: string): SimLinkParams | null {
  const h = (hash ?? '').replace(/^#/, '');
  if (!h.startsWith('sim=')) return null;
  const sp = new URLSearchParams(h.slice(4));

  const line = (sp.get('line') ?? '').trim();
  if (!line) return null;

  // 种子必须为严格整数且在合法区间，否则整段拒绝
  const seedRaw = (sp.get('seed') ?? '').trim();
  if (!/^-?\d+$/.test(seedRaw)) return null;
  const seed = parseInt(seedRaw, 10);
  if (seed < -1 || seed > INT32_MAX) return null;

  const num = (key: string, def: number, min: number, max: number): number => {
    const raw = sp.get(key);
    // 缺失键的 get 返回 null，Number(null) === 0 是有限数——必须先判空再转换（教训 #10 同族：类型陷阱）
    if (raw === null || raw.trim() === '') return def;
    const v = Number(raw);
    if (!Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, Math.floor(v)));
  };

  return {
    line,
    autoStationCount: num('auto', DEFAULTS.autoStationCount, ...BOUNDS.autoStationCount),
    countDirect: num('gd', DEFAULTS.countDirect, ...BOUNDS.countDirect),
    countExpress: num('ge', DEFAULTS.countExpress, ...BOUNDS.countExpress),
    countSkip: num('gs', DEFAULTS.countSkip, ...BOUNDS.countSkip),
    seats: num('seats', DEFAULTS.seats, ...BOUNDS.seats),
    requests: num('req', DEFAULTS.requests, ...BOUNDS.requests),
    seed
  };
}
