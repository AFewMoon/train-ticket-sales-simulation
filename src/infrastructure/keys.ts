/* 强类型 KeyRegistry：每个 localStorage key 绑定唯一的 DTO 类型与 fallback，
   配合 LocalStorageRepository<T> 实现存取类型安全（数据流转的单一出口）。
   教训 #16：localStorage 无迁移框架，结构变更须在读取入口做显式形状探测
   （旧队列 buckets 结构的探测见 reconciliation.ts）。 */

import type { Station } from '../domain/model/station';
import type { Line } from '../domain/model/line';
import type { Train } from '../domain/model/train';
import type { OrderDto } from '../domain/model/order';
import type { DomainEvent } from '../domain/model/event';
import type { QueueFile, SeqPool } from './persistence-shapes';

export interface KeyDefinition<T> {
  readonly key: string;
  readonly fallback: T;
}

function def<T>(key: string, fallback: T): KeyDefinition<T> {
  return { key, fallback };
}

/** 全部持久化 key（tts: 前缀）。删除了无任何读写方的残留键 tts:passengers */
export const KEYS = {
  stations: def<Station[]>('tts:stations', []),
  lines: def<Line[]>('tts:lines', []),
  trains: def<Train[]>('tts:trains', []),
  orders: def<OrderDto[]>('tts:orders', []),
  queues: def<QueueFile>('tts:queues', { trains: {} }),
  events: def<DomainEvent[]>('tts:events', []),
  seq: def<SeqPool>('tts:seq', { stationNos: [], trainCodes: [] }),
  seeded: def<string | null>('tts:seeded', null)
} as const;

export type KeyRegistry = typeof KEYS;

/** 已退役键：迁移清理时移除（乘车人实体已删除，教训 #21） */
export const REMOVED_KEYS = ['tts:passengers'] as const;

export function removeLegacyKeys(storage: { removeItem(key: string): void }): void {
  REMOVED_KEYS.forEach((key) => {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
  });
}
