/* 泛型 localStorage 仓库：JSON 容错读写，类型由 KeyDefinition<T> 绑定。
   行为与旧 storage.js 逐条对齐：
   - read：raw 为 null / JSON 解析失败 / 值为 null|undefined 时回退 fallback；
   - write：序列化写入，失败（配额/隐私模式）返回 false；
   - remove：静默容错。 */

import type { IRepository } from '../domain/repository';
import type { KeyDefinition } from './keys';
import type { StorageLike } from './storage';

export class LocalStorageRepository<T> implements IRepository<T> {
  constructor(
    private readonly storage: StorageLike,
    private readonly definition: KeyDefinition<T>
  ) {}

  read(): T {
    try {
      const raw = this.storage.getItem(this.definition.key);
      if (raw === null) return this.freshFallback();
      const val: unknown = JSON.parse(raw);
      return val === null || val === undefined ? this.freshFallback() : (val as T);
    } catch {
      return this.freshFallback();
    }
  }

  /** fallback 副本：数组/对象 fallback 是注册表中的共享实例，
      直接返回会让各仓库/容器共享同一可变数组（跨容器污染） */
  private freshFallback(): T {
    const f = this.definition.fallback;
    if (Array.isArray(f)) return f.slice() as unknown as T;
    if (f !== null && typeof f === 'object') return { ...(f as object) } as unknown as T;
    return f;
  }

  write(value: T): boolean {
    try {
      this.storage.setItem(this.definition.key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  remove(): void {
    try {
      this.storage.removeItem(this.definition.key);
    } catch {
      /* ignore */
    }
  }
}

export function createRepository<T>(storage: StorageLike, definition: KeyDefinition<T>): LocalStorageRepository<T> {
  return new LocalStorageRepository<T>(storage, definition);
}
