/* 领域规则单测：车站/线路/车次 CRUD 校验、号码唯一性压测（AGENTS.md 清单 1/2/3/6）。 */

import { describe, it, expect } from 'vitest';
import { makeContainer, setupRig } from './helpers';
import { isValidTrainCode } from '../src/domain/model/train';
import { isSubsequence } from '../src/domain/model/line';

describe('车站登记', () => {
  it('号码唯一且随机（pad3 格式）；重复中文名被拒', () => {
    const c = makeContainer();
    const r1 = c.stations.add('北京南', 'Beijingnan');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.no).toMatch(/^\d{3}$/);
    expect(c.stations.add('北京南', 'Beijingnan2').ok).toBe(false);
    expect(c.stations.add('', '').ok).toBe(false);
  });

  it('号码唯一性压测：批量分配零重复（教训 #10/#17）', () => {
    const c = makeContainer();
    const nos = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const res = c.stations.add('压测站' + i, 'Stress' + i);
      if (!res.ok) throw new Error('第 ' + i + ' 个分配失败：' + res.msg);
      nos.add(res.value.no);
    }
    expect(nos.size).toBe(600); // 全量分配后零重复
  });

  it('被车次引用的车站禁删；未被引用可删', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站']);
    expect(c.stations.remove(rig.nos[0] as string).ok).toBe(false);
    // 删除车次后可删车站
    expect(c.trains.remove(rig.trainCode).ok).toBe(true);
    expect(c.stations.remove(rig.nos[0] as string).ok).toBe(true);
  });
});

describe('车次号', () => {
  it('格式校验：G/D/K + 4 位（首位 1~3/6~8，末位奇数）', () => {
    expect(isValidTrainCode('G1235')).toBe(true);
    expect(isValidTrainCode('D8761')).toBe(true);
    expect(isValidTrainCode('K3333')).toBe(true);
    expect(isValidTrainCode('G1234')).toBe(false); // 末位偶数
    expect(isValidTrainCode('G0235')).toBe(false); // 首位 0
    expect(isValidTrainCode('G12355')).toBe(false); // 长度
    expect(isValidTrainCode('X1235')).toBe(false); // 字头
    expect(isValidTrainCode('')).toBe(false);
  });

  it('自定义车次号重复被拒；非法格式被拒', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 2 });
    const t2 = c.trains.add([rig.nos[0] as string, rig.nos[1] as string], 2, rig.lineId, null, 'K1357');
    expect(t2.ok).toBe(true);
    const t3 = c.trains.add([rig.nos[0] as string, rig.nos[1] as string], 2, rig.lineId, null, 'K1357');
    expect(t3.ok).toBe(false);
    expect(t3.ok ? '' : t3.msg).toContain('已存在');
    const t4 = c.trains.add([rig.nos[0] as string, rig.nos[1] as string], 2, rig.lineId, null, 'K1358');
    expect(t4.ok).toBe(false); // 末位偶数
  });

  it('车次号随机生成符合位值规则', () => {
    const c = makeContainer();
    for (let i = 0; i < 20; i++) {
      const rig = setupRig(c, ['甲' + i, '乙' + i]);
      expect(rig.trainCode).toMatch(/^[GDK][123678]\d{2}[13579]$/);
    }
  });

  it('有订单（含已取消历史）的车次禁删', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 2 });
    const o = c.ticketing.purchase(rig.trainCode, 0, 1);
    if (!(o.ok && o.issued)) throw new Error('应出票');
    c.ticketing.refundOrder(o.ok && o.issued ? o.order.id : '');
    expect(c.trains.remove(rig.trainCode).ok).toBe(false); // 取消历史仍引用
  });
});

describe('线路', () => {
  it('站序 < 2 站、重复站、未登记站、重名均被拒', () => {
    const c = makeContainer();
    const a = c.stations.add('甲', 'A');
    expect(a.ok).toBe(true);
    const noA = a.ok ? a.value.no : '';
    expect(c.lines.add('线1', [], null).ok).toBe(false);
    expect(c.lines.add('线1', [noA], null).ok).toBe(false);
    expect(c.lines.add('线1', [noA, noA], null).ok).toBe(false);
    expect(c.lines.add('线1', [noA, '999'], null).ok).toBe(false);
    expect(c.lines.add('线1', [noA, '000'], null).ok).toBe(false); // 000 未登记
    expect(c.lines.add('线1', [noA, '001'], null).ok).toBe(false); // 001 未登记
  });

  it('车次站序必须是线路站序的子序列', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲', '乙', '丙', '丁'], { seatCount: 2 });
    expect(isSubsequence([rig.nos[1] as string, rig.nos[3] as string], rig.nos)).toBe(true);
    // 乱序子序列被拒
    const bad = c.trains.add([rig.nos[3] as string, rig.nos[1] as string], 2, rig.lineId, 'G', null);
    expect(bad.ok).toBe(false);
    // 正序子集通过
    const okTrain = c.trains.add([rig.nos[1] as string, rig.nos[3] as string], 2, rig.lineId, 'G', null);
    expect(okTrain.ok).toBe(true);
  });

  it('被车次挂接的线路禁删', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲', '乙']);
    expect(c.lines.remove(rig.lineId).ok).toBe(false);
    c.trains.remove(rig.trainCode);
    expect(c.lines.remove(rig.lineId).ok).toBe(true);
  });
});
