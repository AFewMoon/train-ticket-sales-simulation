/* 迁移与对账单测：旧队列 buckets 结构废弃重建、旧 status 数据兼容、悬空/缺失候补对账（教训 #16）。 */

import { describe, it, expect } from 'vitest';
import { makeContainer, setupRig } from './helpers';
import { KEYS } from '../src/infrastructure/keys';
import { OrderStatus } from '../src/domain/model/order';
import { scanAllTrains } from '../src/domain/services/reconciliation';

function readQueues(c: ReturnType<typeof makeContainer>): Record<string, unknown> {
  return JSON.parse(c.storage.getItem(KEYS.queues.key) ?? '{}') as Record<string, unknown>;
}

describe('旧队列结构（教训 #16：显式形状探测）', () => {
  it('legacy { buckets: [...] } 结构被整体废弃重建为 { trains: {...} }', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 1 });
    const r1 = c.ticketing.purchase(rig.trainCode, 0, 1);
    const r2 = c.ticketing.purchase(rig.trainCode, 0, 1);
    expect(r1.ok && r1.issued).toBe(true);
    expect(r2.ok && !r2.issued).toBe(true);
    const waitingId = r2.ok && !r2.issued && r2.order ? r2.order.id : '';

    // 注入旧结构
    c.storage.setItem(KEYS.queues.key, JSON.stringify({ buckets: { [rig.trainCode]: [] } }));
    const res = scanAllTrains(c.ticketing, c.trains);

    const q = readQueues(c);
    expect(q.buckets).toBeUndefined();
    expect(q.trains).toBeDefined();
    const queue = (q.trains as Record<string, Array<{ id: string }>>)[rig.trainCode];
    expect(queue?.some((e) => e.id === waitingId) ?? false).toBe(true); // 缺失候补按 createdAt 补插
    expect(res.fulfilled).toBe(0); // 座位仍被占用，无法兑现
  });

  it('队列悬空条目（订单已删）出队', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 1 });
    c.ticketing.purchase(rig.trainCode, 0, 1); // 出票占座
    const r = c.ticketing.purchase(rig.trainCode, 0, 1);
    expect(r.ok && !r.issued).toBe(true); // 候补
    // 手动删除订单制造悬空
    c.storage.setItem(KEYS.orders.key, JSON.stringify([]));
    scanAllTrains(c.ticketing, c.trains);
    const q = readQueues(c);
    const queue = (q.trains as Record<string, unknown[]>)[rig.trainCode];
    expect(queue ?? []).toEqual([]);
  });
});

describe('旧订单数据兼容（OrderStatus 序列化）', () => {
  it("旧 'waiting'/'issued' 字符串直接映射；未知值回退 WAITING", () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 5 });
    c.storage.setItem(
      KEYS.orders.key,
      JSON.stringify([
        { id: 'o1', trainCode: rig.trainCode, fromIdx: 0, toIdx: 1, status: 'issued', seatNo: 2, createdAt: 1 },
        { id: 'o2', trainCode: rig.trainCode, fromIdx: 0, toIdx: 1, status: 'waiting', createdAt: 2 },
        { id: 'o3', trainCode: rig.trainCode, fromIdx: 0, toIdx: 1, status: 'weird', createdAt: 3 }
      ])
    );
    const orders = c.ticketing.ordersOfTrain(rig.trainCode);
    expect(orders.find((o) => o.id === 'o1')?.status).toBe(OrderStatus.ISSUED);
    expect(orders.find((o) => o.id === 'o2')?.status).toBe(OrderStatus.WAITING);
    expect(orders.find((o) => o.id === 'o3')?.status).toBe(OrderStatus.WAITING);

    // 对旧 issued 订单执行新语义退票 → CANCELLED 且 seatNo 留档
    const res = c.ticketing.refundOrder('o1');
    expect(res.ok).toBe(true);
    const o1 = c.ticketing.ordersOfTrain(rig.trainCode).find((o) => o.id === 'o1');
    expect(o1?.status).toBe(OrderStatus.CANCELLED);
    expect(o1?.seatNo).toBe(2);
  });

  it('退票后落盘的 status 为小写字符串 cancelled（旧读取方兼容）', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 5 });
    const r = c.ticketing.purchase(rig.trainCode, 0, 1);
    if (!(r.ok && r.issued)) throw new Error('应出票');
    c.ticketing.refundOrder(r.ok && r.issued ? r.order.id : '');
    const raw = JSON.parse(c.storage.getItem(KEYS.orders.key) ?? '[]') as Array<{ status: string }>;
    expect(raw.some((o) => o.status === 'cancelled')).toBe(true);
  });
});

describe('对账入口幂等可重入（教训 #13）', () => {
  it('连续两次 scanAllTrains 结果一致', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站', '丙站'], { seatCount: 1 });
    c.ticketing.purchase(rig.trainCode, 0, 1);
    c.ticketing.purchase(rig.trainCode, 1, 2);
    const a = scanAllTrains(c.ticketing, c.trains);
    const snapshot = c.storage.getItem(KEYS.queues.key);
    const b = scanAllTrains(c.ticketing, c.trains);
    expect(a.fulfilled).toBe(b.fulfilled);
    expect(c.storage.getItem(KEYS.queues.key)).toBe(snapshot);
  });
});
