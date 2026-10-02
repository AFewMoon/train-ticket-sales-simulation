/* 种子数据单测：幂等重入收敛、按名称去重、版本迁移自愈（AGENTS.md 清单 7、教训 #11/#12）。 */

import { describe, it, expect } from 'vitest';
import { makeContainer } from './helpers';
import { BUILTIN_LINES, SEED_VERSION } from '../src/application/builtin-seeder';
import { KEYS } from '../src/infrastructure/keys';

function uniqueBuiltinNames(): number {
  return new Set(BUILTIN_LINES.flatMap((bl) => bl.stations.map((s) => s.n))).size;
}

describe('首次种子化', () => {
  it('八条线路完整落库；车站跨线去重；号码唯一（pad3 格式）', () => {
    const c = makeContainer();
    c.seeder.seedIfEmpty();

    const lines = c.lines.list();
    expect(lines.length).toBe(BUILTIN_LINES.length);
    const stations = c.stations.list();
    expect(stations.length).toBe(uniqueBuiltinNames());

    const nos = new Set(stations.map((s) => s.no));
    expect(nos.size).toBe(stations.length); // 站号唯一
    stations.forEach((s) => expect(s.no).toMatch(/^\d{3}$/));

    const byName = new Map(stations.map((s) => [s.nameZh, s]));
    BUILTIN_LINES.forEach((bl) => {
      const line = lines.find((l) => l.name === bl.name);
      expect(line, bl.name).toBeDefined();
      if (!line) return;
      expect(line.stationSeq.length).toBe(bl.stations.length);
      expect(line.builtin).toBe(true);
      // 大站标记与站表一致且 ⊆ 站序
      expect(line.majorNos.length).toBe(bl.stations.filter((s) => s.major).length);
      line.majorNos.forEach((no) => expect(line.stationSeq.indexOf(no)).toBeGreaterThan(-1));
      // 跨线共享：站序中的站名与内置站表一致（教训 #9：去重键为名称）
      line.stationSeq.forEach((no) => {
        expect(byName.has(stations.find((s) => s.no === no)?.nameZh ?? '')).toBe(true);
      });
    });
  });

  it('seeded 版本写入，重复调用零副作用（幂等）', () => {
    const c = makeContainer();
    c.seeder.seedIfEmpty();
    const snapshot = JSON.stringify([
      c.stations.list(),
      c.lines.list()
    ]);
    c.seeder.seedIfEmpty();
    c.seeder.seedIfEmpty();
    expect(JSON.stringify([c.stations.list(), c.lines.list()])).toBe(snapshot);
  });
});

describe('重入收敛（教训 #11：upsert 复用既有同名车站）', () => {
  it('预存同名车站被复用而非重复创建', () => {
    const c = makeContainer();
    const pre = c.stations.add('北京南', 'PreExisting');
    expect(pre.ok).toBe(true);
    c.seeder.seedIfEmpty();

    const beijings = c.stations.list().filter((s) => s.nameZh === '北京南');
    expect(beijings.length).toBe(1);
    expect(beijings[0]?.no).toBe(pre.ok ? pre.value.no : '');
    const jinghu = c.lines.list().find((l) => l.name === '京沪高铁（四纵）');
    expect(jinghu?.stationSeq[0]).toBe(pre.ok ? pre.value.no : '');
  });
});

describe('版本迁移（教训 #16：版本不匹配自动重建）', () => {
  it('版本号变更后重新对齐站序与大站标记', () => {
    const c = makeContainer();
    c.seeder.seedIfEmpty();

    // 破坏一条内置线路的站序
    const lines = c.lines.list();
    const jinghu = lines.find((l) => l.name === '京沪高铁（四纵）');
    expect(jinghu).toBeDefined();
    if (!jinghu) return;
    jinghu.stationSeq = [];
    jinghu.majorNos = [];
    c.storage.setItem(KEYS.lines.key, JSON.stringify(lines));
    // 降级版本号触发迁移
    c.storage.setItem(KEYS.seeded.key, JSON.stringify('6'));

    c.seeder.seedIfEmpty();
    const repaired = c.lines.list().find((l) => l.name === '京沪高铁（四纵）');
    expect(repaired?.stationSeq.length).toBe(24);
    expect(repaired?.majorNos.length).toBe(6); // 京沪 6 大站
    expect(c.storage.getItem(KEYS.seeded.key)).toBe(JSON.stringify(SEED_VERSION));
  });

  it('重复号码的车站被自动重分配（数据修复迁移）', () => {
    const c = makeContainer();
    // 构造脏数据：两站同号
    c.storage.setItem(
      KEYS.stations.key,
      JSON.stringify([
        { no: '001', nameZh: '北京南', nameEn: 'Beijingnan' },
        { no: '001', nameZh: '廊坊', nameEn: 'Langfang' }
      ])
    );
    c.seeder.seedIfEmpty();
    const stations = c.stations.list();
    const nos = new Set(stations.map((s) => s.no));
    expect(nos.size).toBe(stations.length);
    // 站序引用已同步（廊坊的站序引用跟随新号码）
    const jinghu = c.lines.list().find((l) => l.name === '京沪高铁（四纵）');
    const langfang = stations.find((s) => s.nameZh === '廊坊');
    expect(jinghu?.stationSeq).toContain(langfang?.no);
  });
});
