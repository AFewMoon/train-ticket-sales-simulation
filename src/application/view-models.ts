/* UI 渲染就绪数据（ViewModel）：业务计算全部在应用层完成，
   UI 层只做字符串拼装与 DOM 操作，不接触业务规则。 */

import type { OrderStatus } from '../domain/model/order';
import type { SimType } from '../domain/model/train';

/* ---------- 订单列表 ---------- */

export interface OrderRowView {
  id: string;
  trainCode: string;
  fromLabel: string;
  toLabel: string;
  status: OrderStatus;
  statusLabel: string;
  seatLabel: string;
  refundable: boolean;
  refundLabel: string;
}

/* ---------- 候补列表 ---------- */

export interface WaitingItemView {
  trainCode: string;
  fromLabel: string;
  toLabel: string;
  position: number;
}

/* ---------- 容量提示 ---------- */

export interface CapacityHintView {
  text: string;
  hasTrain: boolean;
}

/* ---------- 座位区间图 ---------- */

export interface SeatSegView {
  /** 块定位（容器宽度百分比） */
  leftPct: number;
  widthPct: number;
  /** 段端站名（未知站兜底） */
  fromLabel: string;
  toLabel: string;
  /** 颜色种子（原订单 ID，渲染侧取模调色） */
  orderId: string;
  segIndex: number;
}

export interface SeatRowView {
  seatNo: number;
  segs: SeatSegView[];
}

export interface AxisTickView {
  label: string;
  align: string;
  transform: string;
}

export interface TrainSeatMapModel {
  code: string;
  typeName: string | null;
  typeBadge: string | null;
  lineName: string | null;
  stationCount: number;
  rows: SeatRowView[];
  axis: AxisTickView[];
}

/* ---------- 数据查询区 ---------- */

export interface QueryRowView {
  fromLabel: string;
  toLabel: string;
  status: OrderStatus;
  statusLabel: string;
  seatLabel: string;
}

export type QueryResultView =
  | { kind: 'no-train' }
  | { kind: 'all'; rows: QueryRowView[] }
  | { kind: 'segment'; title: string; rows: QueryRowView[] };

/* ---------- 仿真 ---------- */

export type SimTrainType = SimType;

export type SimTrainTypeMeta = { typeName: string | null; typeBadge: string | null };
