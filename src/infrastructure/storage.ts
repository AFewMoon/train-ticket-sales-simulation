/* 存储抽象：StorageLike 使存储层可在浏览器（localStorage）与测试（内存）间替换。 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 内存实现：单测与 localStorage 不可用时的兜底 */
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
