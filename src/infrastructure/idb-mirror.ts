/* IndexedDB 内存镜像存储（v3.2 存储升级）：
   StorageLike 同步契约不变（domain/application/ui 零改动），异步性被镜像吸收——
   启动时一次性 getAll 预热内存 Map，此后 read 同步 O(1) 命中；
   setItem/removeItem 同步改镜像并登记脏键，防抖（默认 500ms）合并为一次 IndexedDB 写入，
   visibilitychange(hidden)/pagehide 时兜底 flush，落盘失败回滚脏键稍后重试。

   已知局限（本期不做 BroadcastChannel）：镜像载入后不感知其他标签页的写入，
   多开页面时后写者以自身镜像整体覆盖（与旧 localStorage「读时直读」的跨页语义不同）。

   测试策略：IndexedDB 交互收敛到 IdbLike 最小接口，node 单测注入内存假实现；
   平台探测（indexedDB 全局）只在 createNativeIdb 中出现（教训 #29 模式）。 */

import type { StorageLike } from './storage';

/** IndexedDB 最小键值接口（值一律为 JSON 字符串，与 StorageLike 语义一致） */
export interface IdbLike {
  /** 全量读取（启动预热用）；键值对按键升序，keys 与 values 一一对应 */
  getAll(): Promise<{ key: string; value: string }[]>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 脏键登记：value 为 null 表示待删除 */
type PendingOp = string | null;

export class IdbMirrorStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  private readonly pending = new Map<string, PendingOp>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private disposed = false;

  private readonly onHide = (): void => {
    void this.flushNow();
  };

  private constructor(
    private readonly db: IdbLike,
    entries: { key: string; value: string }[],
    private readonly debounceMs: number
  ) {
    entries.forEach((e) => this.map.set(e.key, e.value));
    // 页面隐藏/关闭时兜底落盘（node 测试环境无 document，守卫）
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('pagehide', this.onHide);
    }
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.onHide();
  };

  /** 打开并预热：全量载入既有数据 */
  static async open(db: IdbLike, debounceMs = 500): Promise<IdbMirrorStorage> {
    const entries = await db.getAll();
    return new IdbMirrorStorage(db, entries, debounceMs);
  }

  /** 当前镜像条目数（迁移决策：0 表示 IndexedDB 无既有数据） */
  get size(): number {
    return this.map.size;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
    this.pending.set(key, value);
    this.scheduleFlush();
  }

  removeItem(key: string): void {
    this.map.delete(key);
    this.pending.set(key, null);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  /** 立即落盘全部待写键（防抖到期/页面隐藏/迁移完成时调用）。
      进行中的 flush 不重入——期间新写入会重新调度，最终由下一轮 flush 收敛。 */
  async flushNow(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = true;
    const batch = new Map(this.pending);
    this.pending.clear();
    try {
      for (const [key, value] of batch) {
        if (value === null) await this.db.delete(key);
        else await this.db.put(key, value);
      }
    } catch (err) {
      // 回滚未落盘的键（保留期间更新的键不覆盖），防抖后重试
      batch.forEach((v, k) => {
        if (!this.pending.has(k)) this.pending.set(k, v);
      });
      console.warn('[tts] IndexedDB 落盘失败，稍后重试', err);
      this.scheduleFlush();
    } finally {
      this.flushing = false;
    }
  }

  /** 解除事件监听并停用（测试辅助；正常生命周期随页面关闭） */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('pagehide', this.onHide);
    }
  }
}

/* ---------- 浏览器 IndexedDB 平台适配（唯一触碰 indexedDB 全局的位置） ---------- */

export function createNativeIdb(dbName = 'tts', storeName = 'kv'): Promise<IdbLike | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return (async (): Promise<IdbLike | null> => {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
        req.onblocked = () => reject(new Error('IndexedDB 打开被阻塞'));
      });

      const store = (mode: IDBTransactionMode): IDBObjectStore => db.transaction(storeName, mode).objectStore(storeName);
      const request = <T>(r: IDBRequest<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error ?? new Error('IndexedDB 请求失败'));
        });

      return {
        async getAll() {
          // 同一事务内 getAllKeys/getAll 均按键升序返回，下标一一对应
          const [keys, values] = await Promise.all([
            request(store('readonly').getAllKeys()),
            request(store('readonly').getAll())
          ]);
          const out: { key: string; value: string }[] = [];
          keys.forEach((k, i) => {
            if (typeof k === 'string') out.push({ key: k, value: String(values[i]) });
          });
          return out;
        },
        async put(key, value) {
          await request(store('readwrite').put(value, key));
        },
        async delete(key) {
          await request(store('readwrite').delete(key));
        }
      };
    } catch {
      return null; // 打开失败/被阻塞：交由上层降级
    }
  })();
}
