/* 订单实体：OrderStatus 严格枚举 + Order 实体类（含状态迁移行为）+ OrderDto（持久化形状）。
   - 枚举序列化为小写字符串，与旧数据 'waiting' | 'issued' 逐字段兼容；
   - CANCELLED 为新增状态：退票/取消候补不再删除订单，保留历史并释放座位占用；
   - createdAt 含同毫秒稳定排序的小数偏移，勿取整（教训 #6）。 */

import type { SeatSegment } from './seat-segment';
import { isValidSegment } from './seat-segment';

export enum OrderStatus {
  /** 候补中 */
  WAITING = 'waiting',
  /** 已出票（占用座位） */
  ISSUED = 'issued',
  /** 已退票 / 已取消候补（保留历史，不参与任何占用统计） */
  CANCELLED = 'cancelled'
}

/** 订单持久化 DTO（与 tts:orders 旧结构逐字段兼容） */
export interface OrderDto {
  id: string;
  trainCode: string;
  /** 左闭右开区间 [fromIdx, toIdx) */
  fromIdx: number;
  toIdx: number;
  status: OrderStatus;
  /** 毫秒时间戳 + 同毫秒稳定排序小数偏移 */
  createdAt: number;
  /** 出票后存在；CANCELLED 保留原座位号供追溯 */
  seatNo?: number;
  /** 自动仿真生成的订单标记（清理时回收） */
  sim?: boolean;
}

/** 旧数据/脏数据的状态解析：仅识别已知枚举值，其余回退 WAITING */
export function parseOrderStatus(raw: unknown): OrderStatus {
  if (raw === OrderStatus.ISSUED) return OrderStatus.ISSUED;
  if (raw === OrderStatus.CANCELLED) return OrderStatus.CANCELLED;
  return OrderStatus.WAITING;
}

/** 订单实体：封装状态迁移，禁止外部直接改写 status */
export class Order {
  id: string;
  trainCode: string;
  fromIdx: number;
  toIdx: number;
  status: OrderStatus;
  createdAt: number;
  seatNo: number | null;
  sim: boolean;

  constructor(dto: OrderDto) {
    this.id = dto.id;
    this.trainCode = dto.trainCode;
    this.fromIdx = dto.fromIdx;
    this.toIdx = dto.toIdx;
    this.status = parseOrderStatus(dto.status);
    this.createdAt = dto.createdAt;
    this.seatNo = dto.seatNo === undefined || dto.seatNo === null ? null : dto.seatNo;
    this.sim = dto.sim === true;
  }

  static fromDto(dto: OrderDto): Order {
    return new Order(dto);
  }

  toDto(): OrderDto {
    const dto: OrderDto = {
      id: this.id,
      trainCode: this.trainCode,
      fromIdx: this.fromIdx,
      toIdx: this.toIdx,
      status: this.status,
      createdAt: this.createdAt
    };
    if (this.seatNo !== null) dto.seatNo = this.seatNo;
    if (this.sim) dto.sim = true;
    return dto;
  }

  isWaiting(): boolean {
    return this.status === OrderStatus.WAITING;
  }

  isIssued(): boolean {
    return this.status === OrderStatus.ISSUED;
  }

  isCancelled(): boolean {
    return this.status === OrderStatus.CANCELLED;
  }

  /** 订单票段视图（候补中无座位号） */
  segment(): SeatSegment {
    return {
      trainCode: this.trainCode,
      fromIdx: this.fromIdx,
      toIdx: this.toIdx,
      ...(this.seatNo !== null ? { seatNo: this.seatNo } : {})
    };
  }

  /** 区间是否合法（起点 < 终点且不越下界） */
  hasValidSegment(): boolean {
    return isValidSegment(this.fromIdx, this.toIdx);
  }

  /** 出票：分配座位（仅候补中可出票） */
  issue(seatNo: number): void {
    if (this.status !== OrderStatus.WAITING) return;
    this.status = OrderStatus.ISSUED;
    this.seatNo = seatNo;
  }

  /** 退票 / 取消候补：保留历史，仅状态迁移 */
  cancel(): void {
    if (this.status === OrderStatus.CANCELLED) return;
    this.status = OrderStatus.CANCELLED;
  }
}
