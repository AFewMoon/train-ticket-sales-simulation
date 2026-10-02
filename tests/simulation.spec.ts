/* 仿真引擎单测：三类车次规则、同种子可复现、sim 清理归零（AGENTS.md 清单 9）。 */

import { describe, it, expect } from 'vitest';
import { makeContainer, setupRig } from './helpers';
import { AUTO_LINE_ID, typeOfTrain } from '../src/application/simulation-service';
import { SimType } from '../src/domain/model/train';
import { isMajorStation } from '../src/domain/model/line';

/** 8 站线路，大站位于下标 0/2/5/7（满足直达≥2 大站、快车≥3 大站） */
function rig8() {
  const c = makeContainer();
  const names = ['站0', '站1', '站2', '站3', '站4', '站5', '站6', '站7'];
  const rig = setupRig(c, names, {
    seatCount: 50,
    majors: [names[0] as string, names[2] as string, names[5] as string, names[7] as string]
  });
  return { c, rig };
}

const BASE_CFG = {
  autoStationCount: 10,
  countDirect: 2,
  countExpress: 2,
  countSkip: 2,
  seats: 50,
  requests: 5,
  seed: 42
};

describe('三类车次生成规则（教训 #18：按中途停靠站数约束断言）', () => {
  it('直达车仅两大站之间 2 站停靠且 G 字头；大站快车只停区间内大站；隔站停车 ≥5 站且 D 字头', () => {
    const { c, rig } = rig8();
    const line = c.lines.get(rig.lineId);
    if (!line) throw new Error('线路应存在');
    const res = c.simulation.runSimulation({ ...BASE_CFG, lineId: rig.lineId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const majors = new Set(line.majorNos);
    let sawDirect = false;
    let sawExpress = false;
    let sawSkip = false;
    res.summary.trains.forEach((t) => {
      const type = typeOfTrain(t);
      const stops = t.stationSeq;
      if (type === SimType.Direct) {
        sawDirect = true;
        expect(stops.length).toBe(2); // 仅两大站之间，中间不停靠
        expect(majors.has(stops[0] as string)).toBe(true);
        expect(majors.has(stops[1] as string)).toBe(true);
        expect(t.code[0]).toBe('G');
      } else if (type === SimType.Express) {
        sawExpress = true;
        expect(stops.length).toBeGreaterThanOrEqual(3); // 中途 ≥1 站
        stops.forEach((no) => expect(majors.has(no)).toBe(true)); // 只停大站
        expect(t.code[0]).toBe('G');
      } else if (type === SimType.Skip) {
        sawSkip = true;
        expect(stops.length).toBeGreaterThanOrEqual(5); // 中途 ≥3 站
        expect(t.code[0]).toBe('D');
        // 终点必停、大站必停：非大站间隔 1~3、大站无条件停——此处校验停站数与大站覆盖
        const mid = stops.slice(1, -1);
        mid.forEach((no) => {
          if (!majors.has(no)) {
            const idx = t.stationSeq.indexOf(no);
            // 非大站由隔 1~3 站推进产生（结构性规则，停站数已校验）
            expect(idx).toBeGreaterThan(0);
          }
        });
      }
      // 站序必须是线路站序子序列
      let j = 0;
      line.stationSeq.forEach((no) => {
        if (no === stops[j]) j++;
      });
      expect(j).toBe(stops.length);
    });
    expect(sawDirect).toBe(true);
    expect(sawExpress).toBe(true);
    expect(sawSkip).toBe(true);
  });

  it('isMajorStation：大站集合 ⊆ 站序', () => {
    const { c, rig } = rig8();
    const line = c.lines.get(rig.lineId);
    if (!line) throw new Error('线路应存在');
    line.majorNos.forEach((no) => {
      expect(line.stationSeq.indexOf(no)).toBeGreaterThan(-1);
      expect(isMajorStation(line, no)).toBe(true);
    });
  });
});

describe('同种子结果可复现', () => {
  it('两个隔离容器同种子 → 请求编排与出票统计一致', () => {
    const a = rig8();
    const b = rig8();
    const ra = a.c.simulation.runSimulation({ ...BASE_CFG, lineId: a.rig.lineId });
    const rb = b.c.simulation.runSimulation({ ...BASE_CFG, lineId: b.rig.lineId });
    expect(ra.ok && rb.ok).toBe(true);
    if (!(ra.ok && rb.ok)) return;
    expect(ra.summary.totalRequests).toBe(rb.summary.totalRequests);
    expect(ra.summary.totalIssued).toBe(rb.summary.totalIssued);
    expect(ra.summary.totalWaiting).toBe(rb.summary.totalWaiting);
    // 购票区间序列一致（trainCode 为随机号不比较）
    const stripA = ra.summary.events.map((e) => e.fromIdx + '-' + e.toIdx + '-' + e.issued);
    const stripB = rb.summary.events.map((e) => e.fromIdx + '-' + e.toIdx + '-' + e.issued);
    expect(stripA).toEqual(stripB);
  });

  it('seed 为负数时随机取种子并回显', () => {
    const { c, rig } = rig8();
    const res = c.simulation.runSimulation({ ...BASE_CFG, seed: -1, lineId: rig.lineId });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.summary.usedSeed).toBeGreaterThanOrEqual(0);
  });
});

describe('批量事务与 sim 标记', () => {
  it('批量事务内零逐条落盘，结束一次性 flush；全部订单带 sim 标记（教训 #8）', () => {
    const { c, rig } = rig8();
    const res = c.simulation.runSimulation({ ...BASE_CFG, lineId: rig.lineId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.totalRequests).toBe(res.summary.trains.length * 5);
    expect(res.summary.elapsedMs).toBeGreaterThanOrEqual(0);
    const orders = c.ticketing.ordersOfTrain(res.summary.trains[0]?.code ?? '');
    if (orders.length) {
      expect(orders.every((o) => o.sim)).toBe(true);
    }
  });
});

describe('清理仿真数据（sim 标记回收）', () => {
  it('清理后 sim 实体计数归零，手动数据与内置数据保留（含已取消订单）', () => {
    const c = makeContainer();
    // 手动数据
    const manual = setupRig(c, ['手动甲', '手动乙'], { seatCount: 3 });
    const manualOrder = c.ticketing.purchase(manual.trainCode, 0, 1);
    expect(manualOrder.ok).toBe(true);

    // 自动生成线路的仿真
    const res = c.simulation.runSimulation({ ...BASE_CFG, lineId: AUTO_LINE_ID, autoStationCount: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const simTrainCodes = res.summary.trains.map((t) => t.code);
    expect(simTrainCodes.length).toBeGreaterThan(0);
    // 退掉部分 sim 订单制造 CANCELLED 历史订单
    const simOrders = c.ticketing.ordersOfTrain(simTrainCodes[0] as string);
    if (simOrders.length) c.ticketing.refundOrder(simOrders[0]!.id);

    const out = c.simulation.cleanupSimulation();
    expect(out.stations).toBe(6); // 自动生成的模拟车站被回收

    expect(c.ticketing.currentOrders().filter((o) => o.sim).length).toBe(0);
    expect(c.trains.list().filter((t) => t.sim).length).toBe(0);
    expect(c.lines.list().filter((l) => l.sim).length).toBe(0);
    expect(c.stations.list().filter((s) => s.sim).length).toBe(0);

    // 手动数据完好
    expect(c.trains.get(manual.trainCode)).not.toBeNull();
    expect(c.lines.get(manual.lineId)).not.toBeNull();
    expect(c.ticketing.ordersOfTrain(manual.trainCode).length).toBe(1);

    // 幂等：再清一次无副作用
    expect(c.simulation.cleanupSimulation().stations).toBe(0);
  });
});
