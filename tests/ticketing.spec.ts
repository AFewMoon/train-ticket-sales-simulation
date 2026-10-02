/* 出票/候补/退票语义单测（AGENTS.md 验证清单 4、退票新语义、教训 #14/#20 相关）。 */

import { describe, it, expect } from 'vitest';
import { makeContainer, setupRig, type TestRig } from './helpers';
import { OrderStatus } from '../src/domain/model/order';
import type { Container } from '../src/container';

function rig4(c: Container, seatCount: number): TestRig {
  return setupRig(c, ['甲站', '乙站', '丙站', '丁站'], { seatCount });
}

describe('购票与出票', () => {
  it('有座区间适配直接出票并分配最小可用座位', () => {
    const c = makeContainer();
    const rig = rig4(c, 5);
    const r1 = c.ticketing.purchase(rig.trainCode, 0, 2);
    expect(r1.ok && r1.issued).toBe(true);
    if (r1.ok && r1.issued) expect(r1.seatNo).toBe(1);

    // 同座位区间冲突 → 分配下一座位
    const r2 = c.ticketing.purchase(rig.trainCode, 0, 2);
    expect(r2.ok && r2.issued).toBe(true);
    if (r2.ok && r2.issued) expect(r2.seatNo).toBe(2);
  });

  it('允许座位存在空洞：后段适配到已有座位的空洞（教训 #20：不按座位上限枚举）', () => {
    const c = makeContainer();
    const rig = rig4(c, 1);
    const r1 = c.ticketing.purchase(rig.trainCode, 0, 2);
    expect(r1.ok && r1.issued).toBe(true);
    const r2 = c.ticketing.purchase(rig.trainCode, 2, 3);
    expect(r2.ok && r2.issued).toBe(true);
    if (r2.ok && r2.issued) expect(r2.seatNo).toBe(1); // 复用座位 1 的空洞
  });

  it('无空闲座位进入候补并返回名次', () => {
    const c = makeContainer();
    const rig = rig4(c, 1);
    c.ticketing.purchase(rig.trainCode, 0, 3);
    const r2 = c.ticketing.purchase(rig.trainCode, 0, 3);
    expect(r2.ok && !r2.issued).toBe(true);
    if (r2.ok && !r2.issued) expect(r2.position).toBe(1);
  });

  it('非法区间与越界区间被拒', () => {
    const c = makeContainer();
    const rig = rig4(c, 5);
    expect(c.ticketing.purchase(rig.trainCode, 2, 1).ok).toBe(false);
    expect(c.ticketing.purchase(rig.trainCode, 0, 5).ok).toBe(false);
    expect(c.ticketing.purchase('G9999', 0, 1).ok).toBe(false);
  });
});

describe('退票（CANCELLED 新语义：保留历史）', () => {
  it('退票释放区间后候补按时间戳补录，原订单保留为 CANCELLED', () => {
    const c = makeContainer();
    const rig = rig4(c, 1);
    const a = c.ticketing.purchase(rig.trainCode, 0, 3);
    const b = c.ticketing.purchase(rig.trainCode, 0, 3);
    expect(a.ok && a.issued).toBe(true);
    expect(b.ok && !b.issued).toBe(true);

    const res = c.ticketing.refundOrder((a.ok && a.issued && a.order.id) || '');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fulfilled).toBe(1); // b 兑现

    const orders = c.ticketing.ordersOfTrain(rig.trainCode);
    expect(orders.length).toBe(2); // 历史保留
    const aOrder = orders.find((o) => o.id === (a.ok && a.issued ? a.order.id : ''));
    expect(aOrder?.status).toBe(OrderStatus.CANCELLED);
    expect(aOrder?.seatNo).toBe(1); // 座位号留档

    const bOrder = orders.find((o) => o.id === (b.ok && !b.issued && b.order ? b.order.id : ''));
    expect(bOrder?.status).toBe(OrderStatus.ISSUED);
    expect(bOrder?.seatNo).toBe(1); // 补录到释放的座位
  });

  it('CANCELLED 订单不参与占用统计', () => {
    const c = makeContainer();
    const rig = rig4(c, 2);
    const a = c.ticketing.purchase(rig.trainCode, 0, 3);
    expect(a.ok && a.issued).toBe(true);
    if (a.ok && a.issued) c.ticketing.refundOrder(a.order.id);

    const train = c.trains.get(rig.trainCode);
    expect(train).not.toBeNull();
    if (!train) return;
    const summary = c.ticketing.capacitySummary(train, c.ticketing.ordersOfTrain(rig.trainCode));
    expect(summary.emptySeatCount).toBe(2); // 释放后两座全空
    expect(summary.freeSegments).toBe(6); // 3 段 × 2 座
  });

  it('重复退票被拒（幂等保护）', () => {
    const c = makeContainer();
    const rig = rig4(c, 5);
    const a = c.ticketing.purchase(rig.trainCode, 0, 2);
    if (!(a.ok && a.issued)) throw new Error('应出票');
    expect(c.ticketing.refundOrder(a.order.id).ok).toBe(true);
    expect(c.ticketing.refundOrder(a.order.id).ok).toBe(false);
  });

  it('取消候补：状态置 CANCELLED 并出队', () => {
    const c = makeContainer();
    const rig = rig4(c, 1);
    c.ticketing.purchase(rig.trainCode, 0, 3);
    const b = c.ticketing.purchase(rig.trainCode, 0, 3);
    if (!(b.ok && !b.issued && b.order)) throw new Error('应候补');
    expect(c.ticketing.refundOrder(b.order.id).ok).toBe(true);
    expect(c.ticketing.waitingOrdersOfTrain(rig.trainCode).length).toBe(0);
    const cancelled = c.ticketing.ordersOfTrain(rig.trainCode).find((o) => o.id === b.order?.id);
    expect(cancelled?.status).toBe(OrderStatus.CANCELLED);
  });

  it('多个候补按 createdAt 升序兑现（FIFO）', () => {
    const c = makeContainer();
    const rig = rig4(c, 1);
    const a = c.ticketing.purchase(rig.trainCode, 0, 3);
    const b = c.ticketing.purchase(rig.trainCode, 0, 3);
    const d = c.ticketing.purchase(rig.trainCode, 0, 3);
    if (!(a.ok && a.issued && b.ok && !b.issued && b.order && d.ok && !d.issued && d.order)) {
      throw new Error('场景构造失败');
    }
    c.ticketing.refundOrder(a.order.id);
    const statuses = c.ticketing
      .ordersOfTrain(rig.trainCode)
      .map((o) => ({ id: o.id, status: o.status }));
    const bOrder = statuses.find((o) => o.id === b.order?.id);
    const dOrder = statuses.find((o) => o.id === d.order?.id);
    expect(bOrder?.status).toBe(OrderStatus.ISSUED); // 先入队先兑现
    expect(dOrder?.status).toBe(OrderStatus.WAITING);
  });
});

describe('批量事务', () => {
  it('beginBatch/endBatch：批次内零逐条落盘，结束后一次性持久化', () => {
    const c = makeContainer();
    const rig = rig4(c, 3);
    c.ticketing.beginBatch();
    for (let i = 0; i < 5; i++) {
      c.ticketing.purchase(rig.trainCode, i % 3, Math.min(i % 3 + 1, 3));
    }
    // 批次中数据只落内存缓存：直接读 raw 应为空
    expect(c.storage.getItem('tts:orders')).toBeNull();
    c.ticketing.endBatch();
    expect(c.storage.getItem('tts:orders')).not.toBeNull();
    expect(c.ticketing.ordersOfTrain(rig.trainCode).length).toBe(5);
  });
});

describe('容量摘要', () => {
  it('未占用座位以计数计入，不逐座枚举', () => {
    const c = makeContainer();
    const rig = rig4(c, 100000);
    const r = c.ticketing.purchase(rig.trainCode, 0, 2);
    expect(r.ok && r.issued).toBe(true);
    const train = c.trains.get(rig.trainCode);
    if (!train) throw new Error('车次应存在');
    const summary = c.ticketing.capacitySummary(train, c.ticketing.ordersOfTrain(rig.trainCode));
    expect(summary.perSeat.length).toBe(1); // 只遍历已占用座位
    expect(summary.emptySeatCount).toBe(99999);
  });
});
