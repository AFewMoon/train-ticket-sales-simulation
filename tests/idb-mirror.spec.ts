/* IndexedDB 内存镜像存储单测：同步读写语义、防抖合并落盘、删除语义、
   落盘失败回滚重试、flushNow 兜底、localStorage→IndexedDB 幂等迁移（教训 #29：IdbLike 可注入假实现）。 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdbMirrorStorage, type IdbLike } from '../src/infrastructure/idb-mirror';
import { InMemoryStorage, migrateLegacyToMirror } from '../src/infrastructure/storage';

/** 内存版 IdbLike 假实现：putCount 记录写入次数（断言防抖合并），failNextPut 注入失败 */
function makeFakeDb(): IdbLike & { putCount: () => number; failNextPut: () => void } {
  const store = new Map<string, string>();
  let puts = 0;
  let failOnce = false;
  return {
    async getAll() {
      return Array.from(store.entries()).map(([key, value]) => ({ key, value }));
    },
    async put(key, value) {
      if (failOnce) {
        failOnce = false;
        throw new Error('注入的落盘失败');
      }
      puts++;
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    putCount: () => puts,
    failNextPut: () => {
      failOnce = true;
    }
  };
}

/** 打开镜像并等待（open 内 getAll 为异步） */
async function makeMirror(db: ReturnType<typeof makeFakeDb>, debounceMs = 500): Promise<IdbMirrorStorage> {
  return IdbMirrorStorage.open(db, debounceMs);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IdbMirrorStorage 同步语义', () => {
  it('预热载入既有数据，getItem 同步命中；无键返回 null', async () => {
    const db = makeFakeDb();
    await db.put('tts:stations', '[]');
    const mirror = await makeMirror(db);
    expect(mirror.size).toBe(1);
    expect(mirror.getItem('tts:stations')).toBe('[]');
    expect(mirror.getItem('tts:missing')).toBeNull();
    mirror.dispose();
  });

  it('setItem 同步可见，防抖到期后落盘', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    mirror.setItem('tts:orders', '[1]');
    expect(mirror.getItem('tts:orders')).toBe('[1]');
    expect(db.putCount()).toBe(0); // 防抖窗口内未落盘
    await vi.advanceTimersByTimeAsync(500);
    expect(db.putCount()).toBe(1);
    const rows = await db.getAll();
    expect(rows).toEqual([{ key: 'tts:orders', value: '[1]' }]);
    mirror.dispose();
  });

  it('防抖窗口内同键多次写入合并为一次（保留末值）', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    mirror.setItem('tts:seq', 'v1');
    mirror.setItem('tts:seq', 'v2');
    mirror.setItem('tts:seq', 'v3');
    await vi.advanceTimersByTimeAsync(500);
    expect(db.putCount()).toBe(1);
    expect((await db.getAll()).find((r) => r.key === 'tts:seq')?.value).toBe('v3');
    mirror.dispose();
  });

  it('removeItem 同步生效并落盘删除；删除后读回 null', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    mirror.setItem('tts:events', 'e1');
    await vi.advanceTimersByTimeAsync(500);
    mirror.removeItem('tts:events');
    expect(mirror.getItem('tts:events')).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(await db.getAll()).toEqual([]);
    mirror.dispose();
  });

  it('flushNow 跳过防抖立即落盘', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    mirror.setItem('tts:trains', 't1');
    await mirror.flushNow();
    expect(db.putCount()).toBe(1);
    mirror.dispose();
  });
});

describe('IdbMirrorStorage 可靠性', () => {
  it('落盘失败：镜像值保留、脏键回滚并自动重试成功', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    db.failNextPut();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mirror.setItem('tts:queues', 'q1');
    await vi.advanceTimersByTimeAsync(500); // 第一次 flush 失败
    expect(db.putCount()).toBe(0);
    expect(mirror.getItem('tts:queues')).toBe('q1'); // 镜像不受落盘失败影响
    await vi.advanceTimersByTimeAsync(500); // 重试
    expect(db.putCount()).toBe(1);
    expect((await db.getAll())[0]?.value).toBe('q1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    mirror.dispose();
  });

  it('flush 进行中的新写入不会被覆盖，下一轮收敛', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    mirror.setItem('tts:a', '1');
    await mirror.flushNow();
    mirror.setItem('tts:b', '2');
    await mirror.flushNow();
    const keys = (await db.getAll()).map((r) => r.key).sort();
    expect(keys).toEqual(['tts:a', 'tts:b']);
    mirror.dispose();
  });

  it('dispose 后停止调度落盘', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    mirror.setItem('tts:x', 'x');
    mirror.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.putCount()).toBe(0);
  });
});

describe('localStorage → IndexedDB 幂等迁移', () => {
  it('镜像为空且存在旧数据：写入镜像、落盘、清除旧键', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    const removed: string[] = [];
    const old = new InMemoryStorage();
    old.setItem('tts:stations', '["甲"]');
    old.setItem('tts:orders', '[]');

    await migrateLegacyToMirror(mirror, [
      ['tts:stations', '["甲"]'],
      ['tts:orders', '[]']
    ], (k) => {
      removed.push(k);
      old.removeItem(k);
    });

    expect(removed.sort()).toEqual(['tts:orders', 'tts:stations']);
    expect(old.getItem('tts:stations')).toBeNull(); // 旧键已清除，无双份数据
    const rows = await db.getAll();
    expect(rows.length).toBe(2);
    expect(mirror.getItem('tts:stations')).toBe('["甲"]');
    mirror.dispose();
  });

  it('镜像非空（IndexedDB 已有数据）时跳过迁移，不覆盖新数据', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    mirror.setItem('tts:stations', '["新站"]');
    await mirror.flushNow();
    const before = db.putCount();

    await migrateLegacyToMirror(mirror, [['tts:stations', '["旧站"]']], () => {
      throw new Error('不应清除任何键');
    });

    expect(mirror.getItem('tts:stations')).toBe('["新站"]');
    expect(db.putCount()).toBe(before); // 无新写入
    mirror.dispose();
  });

  it('旧数据为空时不动镜像', async () => {
    const db = makeFakeDb();
    const mirror = await makeMirror(db);
    await migrateLegacyToMirror(mirror, [], () => {
      throw new Error('不应清除任何键');
    });
    expect(db.putCount()).toBe(0);
    mirror.dispose();
  });
});
