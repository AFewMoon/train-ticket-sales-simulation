/* 批量事务缓冲：将高频读写的仓库收敛到内存缓存、结束时一次性落盘。
   对应旧 ticketing.js 的 beginBatch/endBatch（orders/queues/events 三仓库）。
   - BatchScope 实现.Tx 接口；directTx 为无批量的直通实现；
   - 同一仓库实例在缓存中只有一份值，load 返回缓存，save 覆盖并标记脏。 */

import type { IRepository } from '../domain/repository';

export interface Tx {
  load<T>(repo: IRepository<T>): T;
  save<T>(repo: IRepository<T>, value: T): void;
}

export class BatchScope implements Tx {
  private cache = new Map<IRepository<unknown>, unknown>();
  private dirty = new Set<IRepository<unknown>>();

  load<T>(repo: IRepository<T>): T {
    const key = repo as IRepository<unknown>;
    if (!this.cache.has(key)) this.cache.set(key, repo.read());
    return this.cache.get(key) as T;
  }

  save<T>(repo: IRepository<T>, value: T): void {
    const key = repo as IRepository<unknown>;
    this.cache.set(key, value);
    this.dirty.add(key);
  }

  /** 将脏仓库一次性写回。批量事务内零逐条落盘（教训 #9） */
  flush(): void {
    this.dirty.forEach((repo) => {
      if (this.cache.has(repo)) repo.write(this.cache.get(repo));
    });
    this.cache.clear();
    this.dirty.clear();
  }
}

export const directTx: Tx = {
  load: <T>(repo: IRepository<T>): T => repo.read(),
  save: <T>(repo: IRepository<T>, value: T): void => {
    repo.write(value);
  }
};
