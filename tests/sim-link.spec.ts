import { describe, it, expect } from 'vitest';
import { buildSimHash, parseSimHash, type SimLinkParams } from '../src/ui/sim-link';

const BASE: SimLinkParams = {
  line: '京沪高铁',
  autoStationCount: 10,
  countDirect: 2,
  countExpress: 2,
  countSkip: 2,
  seats: 4,
  requests: 10,
  seed: 12345
};

describe('仿真参数链接', () => {
  it('buildSimHash 生成 #sim= 前缀的 hash，中文名被转义', () => {
    const hash = buildSimHash(BASE);
    expect(hash.startsWith('#sim=')).toBe(true);
    expect(hash).toContain('line=' + encodeURIComponent('京沪高铁'));
    expect(hash).toContain('seed=12345');
  });

  it('编码 → 解码往返一致（含中文线路名）', () => {
    expect(parseSimHash(buildSimHash(BASE))).toEqual(BASE);
  });

  it('__auto__ 线路往返一致', () => {
    const p: SimLinkParams = { ...BASE, line: '__auto__', autoStationCount: 15, seed: 0 };
    expect(parseSimHash(buildSimHash(p))).toEqual(p);
  });

  it('缺省数值参数回退表单默认值', () => {
    const p = parseSimHash('#sim=' + new URLSearchParams({ line: '京沪高铁', seed: '7' }).toString());
    expect(p).toEqual({
      line: '京沪高铁',
      autoStationCount: 10,
      countDirect: 2,
      countExpress: 2,
      countSkip: 2,
      seats: 4,
      requests: 10,
      seed: 7
    });
  });

  it('越界数值钳制到合法区间（auto>30 收敛为 30、seats<1 收敛为 1）', () => {
    const p = parseSimHash(
      '#sim=' +
        new URLSearchParams({
          line: 'x',
          seed: '1',
          auto: '100',
          seats: '0',
          gd: '-5'
        }).toString()
    );
    expect(p?.autoStationCount).toBe(30);
    expect(p?.seats).toBe(1);
    expect(p?.countDirect).toBe(0);
  });

  it('无 sim 段 / line 缺失 / seed 缺失 → null（整段忽略）', () => {
    expect(parseSimHash('#other=1')).toBeNull();
    expect(parseSimHash('')).toBeNull();
    expect(parseSimHash('#sim=' + new URLSearchParams({ auto: '10', seed: '1' }).toString())).toBeNull();
    expect(parseSimHash('#sim=' + new URLSearchParams({ line: 'x' }).toString())).toBeNull();
  });

  it('非法种子（非整数 / 浮点 / 超 int32 / 越下界）→ null（复现根基宁缺毋错）', () => {
    const withSeed = (seed: string): string =>
      '#sim=' + new URLSearchParams({ line: 'x', seed }).toString();
    expect(parseSimHash(withSeed('abc'))).toBeNull();
    expect(parseSimHash(withSeed('3.5'))).toBeNull();
    expect(parseSimHash(withSeed('2147483648'))).toBeNull();
    expect(parseSimHash(withSeed('-2'))).toBeNull();
  });

  it('种子 0 与 -1 为合法值（0 不可被默认值吞掉）', () => {
    expect(parseSimHash(buildSimHash({ ...BASE, seed: 0 }))?.seed).toBe(0);
    expect(parseSimHash(buildSimHash({ ...BASE, seed: -1 }))?.seed).toBe(-1);
  });
});
