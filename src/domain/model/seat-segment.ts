/* SeatSegment 值对象：车次内的座位占用区间，左闭右开 [fromIdx, toIdx)。 */

/** 座位票段：车次站序上的左闭右开区间，出票后携带座位号 */
export interface SeatSegment {
  readonly trainCode: string;
  /** 起点站在车次站序中的下标（含） */
  readonly fromIdx: number;
  /** 终点站在车次站序中的下标（不含） */
  readonly toIdx: number;
  /** 出票后存在的座位号；候补中无 */
  readonly seatNo?: number;
}

/** 合法区间：起点下标 >= 0 且终点严格大于起点（原 Domain.isValidRange 语义） */
export function isValidSegment(fromIdx: number, toIdx: number): boolean {
  return fromIdx >= 0 && toIdx > fromIdx;
}

/** 该票段是否覆盖第 segIdx 个相邻区间段（用于按段查询已出票订单） */
export function coversSegment(seg: Pick<SeatSegment, 'fromIdx' | 'toIdx'>, segIdx: number): boolean {
  return seg.fromIdx <= segIdx && seg.toIdx > segIdx;
}

/** 两区间是否重叠（左闭右开） */
export function overlaps(
  a: Pick<SeatSegment, 'fromIdx' | 'toIdx'>,
  b: Pick<SeatSegment, 'fromIdx' | 'toIdx'>
): boolean {
  return a.fromIdx < b.toIdx && b.fromIdx < a.toIdx;
}
