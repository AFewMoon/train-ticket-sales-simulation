/* 领域事件：购票/出票/候补/退票/兑现，持久化于 tts:events（上限 500 条，最新置顶）。 */

export enum EventType {
  Purchase = 'purchase',
  Issued = 'issued',
  Waitlisted = 'waitlisted',
  Refund = 'refund',
  Fulfilled = 'fulfilled'
}

export interface DomainEvent {
  id: string;
  ts: number;
  type: EventType;
  trainCode: string;
  orderId: string;
  detail: string;
}

/** 旧数据可能残留未知事件类型（教训 #23），运行时守卫 + 渲染占位兜底 */
export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (Object.values(EventType) as string[]).indexOf(v) !== -1;
}

export interface EventMeta {
  label: string;
  cls: string;
}

export const EVENT_META: Record<EventType, EventMeta> = {
  [EventType.Purchase]: { label: '购票', cls: 'ev-purchase' },
  [EventType.Issued]: { label: '出票', cls: 'ev-issued' },
  [EventType.Waitlisted]: { label: '候补', cls: 'ev-waitlisted' },
  [EventType.Refund]: { label: '退票', cls: 'ev-refund' },
  [EventType.Fulfilled]: { label: '兑现', cls: 'ev-fulfilled' }
};

/** 未知事件类型的渲染兜底元数据 */
export const UNKNOWN_EVENT_META: EventMeta = { label: '事件', cls: '' };
