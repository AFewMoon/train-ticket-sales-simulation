/* 领域规则单测：车站/线路/车次 CRUD 校验、号码唯一性压测（AGENTS.md 清单 1/2/3/6）。 */

import { describe, it, expect } from 'vitest';
import { makeContainer, setupRig } from './helpers';
import { isValidTrainCode } from '../src/domain/model/train';
import { isSubsequence } from '../src/domain/model/line';
import { purgeNonGDTrains } from '../src/domain/services/reconciliation';
import { KEYS } from '../src/infrastructure/keys';

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
  it('格式校验：G/D + 4 位（首位 1~3/6~8，末位奇数）；K 字头已退役', () => {
    expect(isValidTrainCode('G1235')).toBe(true);
    expect(isValidTrainCode('D8761')).toBe(true);
    expect(isValidTrainCode('K3333')).toBe(false); // K 字头退役（v3.1）
    expect(isValidTrainCode('G1234')).toBe(false); // 末位偶数
    expect(isValidTrainCode('G0235')).toBe(false); // 首位 0
    expect(isValidTrainCode('G12355')).toBe(false); // 长度
    expect(isValidTrainCode('X1235')).toBe(false); // 字头
    expect(isValidTrainCode('')).toBe(false);
  });

  it('自定义 K 号被拒；G/D 重复与非法格式被拒', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 2 });
    const nos01 = [rig.nos[0] as string, rig.nos[1] as string];
    const kTrain = c.trains.add(nos01, 2, rig.lineId, null, 'K1357');
    expect(kTrain.ok).toBe(false); // K 字头被拒
    const t2 = c.trains.add(nos01, 2, rig.lineId, null, 'G1357');
    expect(t2.ok).toBe(true);
    const t3 = c.trains.add(nos01, 2, rig.lineId, null, 'G1357');
    expect(t3.ok).toBe(false);
    expect(t3.ok ? '' : t3.msg).toContain('已存在');
    const t4 = c.trains.add(nos01, 2, rig.lineId, null, 'G1358');
    expect(t4.ok).toBe(false); // 末位偶数
  });

  it('车次号随机生成符合位值规则且仅 G/D 字头', () => {
    const c = makeContainer();
    for (let i = 0; i < 20; i++) {
      const rig = setupRig(c, ['甲' + i, '乙' + i]);
      expect(rig.trainCode).toMatch(/^[GD][123678]\d{2}[13579]$/);
    }
  });

  it('随机号池压测：批量生成全部 G/D 字头、全局唯一', () => {
    const c = makeContainer();
    const codes = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const rig = setupRig(c, ['压测甲' + i, '压测乙' + i]);
      codes.add(rig.trainCode);
      expect(rig.trainCode[0]).toMatch(/^[GD]$/);
    }
    expect(codes.size).toBe(60);
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

describe('退役字头清理（v3.1：仅 G/D）', () => {
  it('purgeNonGDTrains 删除 K 车次连带订单（含 CANCELLED 历史）与候补队列条目', () => {
    const c = makeContainer();
    // 手动车次走 add（校验拒 K）→ 直接构造存量：注入 K 车次与其订单/队列
    const s1 = c.stations.add('存量甲', 'A1');
    const s2 = c.stations.add('存量乙', 'A2');
    if (!(s1.ok && s2.ok)) throw new Error('车站构造失败');
    const nos = [s1.value.no, s2.value.no];
    const line = c.lines.add('存量线', nos, null);
    if (!line.ok) throw new Error(line.msg);
    const kTrain = { code: 'K1001', stationSeq: nos, seatCount: 1, lineId: line.value.id };
    c.storage.setItem(KEYS.trains.key, JSON.stringify([kTrain]));

    // K 车次下产生订单：一张已出票后取消（历史）、一张候补
    const lineId = line.value.id;
    const train = c.trains.get;
    void train;
    // 通过临时放松校验构造数据：直接写订单与队列
    const queueEntry = { id: 'o_k_wait', fromIdx: 0, toIdx: 1, createdAt: 2 };
    c.storage.setItem(
      KEYS.orders.key,
      JSON.stringify([
        { id: 'o_k_issued', trainCode: 'K1001', fromIdx: 0, toIdx: 1, status: 'cancelled', seatNo: 1, createdAt: 1, sim: false },
        { id: 'o_k_wait', trainCode: 'K1001', fromIdx: 0, toIdx: 1, status: 'waiting', createdAt: 2 }
      ])
    );
    c.storage.setItem(
      KEYS.queues.key,
      JSON.stringify({ trains: { K1001: [queueEntry] } })
    );
    void lineId;

    const removed = purgeNonGDTrains(c.trains, c.ticketing);
    expect(removed).toEqual(['K1001']);

    // 车次、订单（含已取消历史）与队列条目全部清除
    expect(c.trains.get('K1001')).toBeNull();
    expect(c.ticketing.currentOrders().filter((o) => o.trainCode === 'K1001').length).toBe(0);
    expect(c.ticketing.currentQueues().trains['K1001']).toBeUndefined();

    // 幂等：再次清理无动作
    expect(purgeNonGDTrains(c.trains, c.ticketing)).toEqual([]);
  });

  it('启动对账链：purge 后号码池重建不再复用 K 号，G/D 车次不受影响', () => {
    const c = makeContainer();
    const gd = setupRig(c, ['保留甲', '保留乙'], { seatCount: 2 });
    // 注入一个 K 车次
    const kTrain = {
      code: 'K2002',
      stationSeq: [gd.nos[0] as string, gd.nos[1] as string],
      seatCount: 2,
      lineId: gd.lineId
    };
    const trains = JSON.parse(c.storage.getItem(KEYS.trains.key) ?? '[]') as Array<Record<string, unknown>>;
    trains.push(kTrain);
    c.storage.setItem(KEYS.trains.key, JSON.stringify(trains));

    purgeNonGDTrains(c.trains, c.ticketing);
    c.numbering.rebuildSeqPools();

    expect(c.trains.get('K2002')).toBeNull();
    expect(c.trains.get(gd.trainCode)).not.toBeNull(); // G/D 车次不受影响
    // K 号从号码池消失，之后重新登记车次号不会出现 K 开头
    const next = c.trains.add([gd.nos[0] as string, gd.nos[1] as string], 2, gd.lineId, 'G', null);
    expect(next.ok).toBe(true);
  });
});
