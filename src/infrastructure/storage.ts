/* 存储抽象：StorageLike 使存储层可在浏览器（IndexedDB 镜像/localStorage）与测试（内存）间替换。 */

import { createNativeIdb, IdbMirrorStorage } from './idb-mirror';
import { REMOVED_KEYS } from './keys';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 内存实现：单测与浏览器存储均不可用时的兜底 */
export class InMemoryStorage implements StorageLike {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** 浏览器 localStorage；访问抛异常（隐私模式等）时回退内存实现 */
export function createBrowserStorage(): StorageLike {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* ignore */
  }
  return new InMemoryStorage();
}

/* ================= IndexedDB 升级（v3.2） ================= */

/** 诊断标记：'idb' | 'local' | 'memory'（仿 __ttsCompute 模式，供浏览器回归断言） */
function markStorage(kind: 'idb' | 'local' | 'memory'): void {
  (globalThis as { __ttsStorage?: string }).__ttsStorage = kind;
}

/** 收集 localStorage 中全部 tts:* 旧数据（跳过已退役键，避免迁移已删除实体） */
function collectLegacyTtsEntries(): [string, string][] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const out: [string, string][] = [];
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !k.startsWith('tts:') || (REMOVED_KEYS as readonly string[]).includes(k)) continue;
      const v = ls.getItem(k);
      if (v !== null) out.push([k, v]);
    }
    return out;
  } catch {
    return [];
  }
}

/** 一次性迁移：镜像为空（IndexedDB 无既有数据）且存在旧数据时写入镜像并落盘，成功后清除旧键。
    镜像非空则跳过（避免用旧数据覆盖 IndexedDB 中更新的数据），保证幂等可重入。 */
export async function migrateLegacyToMirror(
  mirror: IdbMirrorStorage,
  legacy: readonly [string, string][],
  removeOld: (key: string) => void
): Promise<void> {
  if (mirror.size > 0 || legacy.length === 0) return;
  legacy.forEach(([k, v]) => mirror.setItem(k, v));
  await mirror.flushNow();
  legacy.forEach(([k]) => removeOld(k));
}

/** 浏览器存储异步工厂：IndexedDB 内存镜像 → localStorage → 内存。
    任一 IndexedDB 环节失败（隐私模式/打开被阻塞/预热异常）即整链回退，行为与旧版一致。 */
export async function createBrowserStorageAsync(): Promise<StorageLike> {
  try {
    const db = await createNativeIdb();
    if (!db) throw new Error('IndexedDB 不可用');
    const mirror = await IdbMirrorStorage.open(db);
    await migrateLegacyToMirror(mirror, collectLegacyTtsEntries(), (key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    });
    markStorage('idb');
    return mirror;
  } catch (err) {
    console.warn('[tts] IndexedDB 不可用，回退 localStorage/内存', err);
    const storage = createBrowserStorage();
    markStorage(storage instanceof InMemoryStorage ? 'memory' : 'local');
    return storage;
  }
}
