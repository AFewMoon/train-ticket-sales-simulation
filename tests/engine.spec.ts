/* 计算引擎与网关单测：
   - 引擎（纯函数）与 Service 直算结果等价；
   - Worker 路径回环（FakeWorker + handleEngineRequest）与直算路径行为等价；
   - 补丁合并（replace-codes / replace-all / merge-append）正确性；
   - Worker 失效自动降级直算。 */

import { describe, it, expect } from 'vitest';
import { makeContainer, setupRig, type TestRig } from './helpers';
import type { Container } from '../src/container';
import { handleEngineRequest } from '../src/domain/engine/dispatch';
import { type EngineRequest, type EngineResponse } from '../src/domain/engine/protocol';
import { WorkerComputeGateway } from '../src/application/compute-gateway';
import { OrderStatus } from '../src/domain/model/order';
import { KEYS } from '../src/infrastructure/keys';

/** 进程内假 Worker：postMessage 同步走引擎调度器并回投响应——完整回环 Worker 路径 */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(req: EngineRequest): void {
    const res: EngineResponse = handleEngineRequest(req);
    queueMicrotask(() => {
      if (this.onmessage) this.onmessage({ data: res });
    });
  }
  terminate(): void {
    /* noop */
  }
}

function twinRigs(): { a: { c: Container; rig: TestRig }; b: { c: Container; rig: TestRig } } {
  const a = makeContainer();
  const b = makeContainer();
  return {
    a: { c: a, rig: setupRig(a, ['甲站', '乙站', '丙站', '丁站'], { seatCount: 2 }) },
    b: { c: b, rig: setupRig(b, ['甲站', '乙站', '丙站', '丁站'], { seatCount: 2 }) }
  };
}

describe('网关两条路径行为等价（直算 vs Worker 回环）', () => {
  it('purchase：出票/候补结果与事件序列一致', async () => {
    const { a, b } = twinRigs();
    const gateway = new WorkerComputeGateway(
      b.c.transport,
      b.c.ticketing,
      b.c.simulation,
      () => new FakeWorker() as unknown as Worker
    );

    const ra = a.c.ticketing.purchase(a.rig.trainCode, 0, 2); // 直算
    const rb = await gateway.purchase(b.rig.trainCode, 0, 2); // Worker 回环
    expect(ra.ok && rb.ok).toBe(true);
    if (ra.ok && rb.ok) {
      expect(ra.issued).toBe(rb.issued);
      expect(ra.issued ? ra.seatNo : ra.position).toBe(rb.issued ? rb.seatNo : rb.position);
    }

    const ra2 = a.c.ticketing.purchase(a.rig.trainCode, 0, 2);
    const rb2 = await gateway.purchase(b.rig.trainCode, 0, 2);
    expect(ra2.ok && rb2.ok).toBe(true);
    if (ra2.ok && rb2.ok) expect(ra2.issued).toBe(rb2.issued);

    // 事件类型序列一致（id/时间戳差异忽略）
    const evTypes = (c: Container): string[] =>
      (JSON.parse(c.storage.getItem(KEYS.events.key) ?? '[]') as Array<{ type: string }>).map((e) => e.type);
    expect(evTypes(b.c)).toEqual(evTypes(a.c));
  });

  it('refundOrder：CANCELLED 语义与候补补录一致', async () => {
    const { a, b } = twinRigs();
    a.c.ticketing.purchase(a.rig.trainCode, 0, 3);
    a.c.ticketing.purchase(a.rig.trainCode, 0, 3);
    b.c.ticketing.purchase(b.rig.trainCode, 0, 3);
    b.c.ticketing.purchase(b.rig.trainCode, 0, 3);

    const gateway = new WorkerComputeGateway(
      b.c.transport,
      b.c.ticketing,
      b.c.simulation,
      () => new FakeWorker() as unknown as Worker
    );

    const issuedA = a.c.ticketing.ordersOfTrain(a.rig.trainCode).find((o) => o.status === OrderStatus.ISSUED);
    const issuedB = b.c.ticketing.ordersOfTrain(b.rig.trainCode).find((o) => o.status === OrderStatus.ISSUED);
    expect(issuedA && issuedB).toBeTruthy();

    const resA = a.c.ticketing.refundOrder(issuedA?.id ?? '');
    const resB = await gateway.refundOrder(issuedB?.id ?? '');
    expect(resA.ok && resB.ok).toBe(true);
    if (resA.ok && resB.ok) expect(resA.fulfilled).toBe(resB.fulfilled);

    const statuses = (c: Container, code: string): string[] =>
      c.ticketing
        .ordersOfTrain(code)
        .map((o) => o.status)
        .sort();
    expect(statuses(b.c, b.rig.trainCode)).toEqual(statuses(a.c, a.rig.trainCode));
  });

  it('simulateResolved：同种子统计与直算一致，sim 车次落盘', async () => {
    const a = makeContainer();
    const b = makeContainer();
    const rigA = setupRig(a, ['站0', '站1', '站2', '站3', '站4', '站5', '站6', '站7'], {
      seatCount: 50,
      majors: ['站0', '站2', '站5', '站7']
    });
    const rigB = setupRig(b, ['站0', '站1', '站2', '站3', '站4', '站5', '站6', '站7'], {
      seatCount: 50,
      majors: ['站0', '站2', '站5', '站7']
    });

    const cfg = {
      autoStationCount: 10,
      countDirect: 2,
      countExpress: 2,
      countSkip: 2,
      seats: 50,
      requests: 5,
      seed: 42
    };
    const direct = a.simulation.runSimulation({ ...cfg, lineId: rigA.lineId });
    const gateway = new WorkerComputeGateway(
      b.transport,
      b.ticketing,
      b.simulation,
      () => new FakeWorker() as unknown as Worker
    );
    const prepared = b.simulation.prepare({ ...cfg, lineId: rigB.lineId });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const viaWorker = await gateway.simulateResolved(prepared.line, prepared.cfg);

    expect(direct.ok && viaWorker.ok).toBe(true);
    if (!(direct.ok && viaWorker.ok)) return;
    expect(viaWorker.summary.usedSeed).toBe(direct.summary.usedSeed);
    expect(viaWorker.summary.totalRequests).toBe(direct.summary.totalRequests);
    expect(viaWorker.summary.totalIssued).toBe(direct.summary.totalIssued);
    expect(viaWorker.summary.totalWaiting).toBe(direct.summary.totalWaiting);
    // sim 车次已由网关落盘并登记号码池
    expect(viaWorker.summary.trains.length).toBeGreaterThan(0);
    viaWorker.summary.trains.forEach((t) => {
      expect(b.trains.get(t.code)).not.toBeNull();
    });
    // 新增订单已打 sim 标记
    const simOrders = b.ticketing.ordersOfTrain(viaWorker.summary.trains[0]?.code ?? '');
    expect(simOrders.length).toBeGreaterThan(0);
    expect(simOrders.every((o) => o.sim)).toBe(true);
  });

  it('reconcile：经网关对账等价于直算', async () => {
    const { a, b } = twinRigs();
    a.c.ticketing.purchase(a.rig.trainCode, 0, 3);
    b.c.ticketing.purchase(b.rig.trainCode, 0, 3);
    const gateway = new WorkerComputeGateway(
      b.c.transport,
      b.c.ticketing,
      b.c.simulation,
      () => new FakeWorker() as unknown as Worker
    );
    const ra = a.c.ticketing.reconcile();
    const rb = await gateway.reconcile();
    expect(ra.fulfilled).toBe(rb.fulfilled);
  });
});

describe('Worker 失效自动降级直算', () => {
  it('postMessage 抛错 → 自动回退 DirectComputeGateway 行为', async () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 3 });
    const broken = new WorkerComputeGateway(
      c.transport,
      c.ticketing,
      c.simulation,
      () =>
        ({
          onmessage: null,
          onerror: null,
          postMessage: () => {
            throw new Error('Worker postMessage failed');
          },
          terminate: () => undefined
        }) as unknown as Worker
    );
    const r = await broken.purchase(rig.trainCode, 0, 1);
    expect(r.ok && r.issued).toBe(true); // 降级直算成功
    const r2 = await broken.purchase(rig.trainCode, 0, 1);
    expect(r2.ok && r2.issued).toBe(true); // 后续请求持续走直算
  });
});

describe('补丁合并（applyPatchToStore）', () => {
  it('replace-codes：只替换目标车次队列，不影响其他车次', () => {
    const c = makeContainer();
    const rig1 = setupRig(c, ['甲站', '乙站'], { seatCount: 2 });
    const rig2 = setupRig(c, ['丙站', '丁站'], { seatCount: 2 });
    const q1 = c.ticketing.currentQueues().trains[rig1.trainCode] ?? [];
    const entry = { id: 'x', fromIdx: 0, toIdx: 1, createdAt: 1 };

    c.ticketing.applyPatch({
      orders: [],
      queueStrategy: 'replace-codes',
      queues: { [rig2.trainCode]: [entry] },
      events: []
    });

    expect(c.ticketing.currentQueues().trains[rig2.trainCode]).toEqual([entry]);
    expect(c.ticketing.currentQueues().trains[rig1.trainCode] ?? []).toEqual(q1);
  });

  it('merge-append：新增候补按 createdAt 归并排序', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 1 });
    c.ticketing.purchase(rig.trainCode, 0, 1); // 占座
    const r = c.ticketing.purchase(rig.trainCode, 0, 1);
    if (!(r.ok && !r.issued)) throw new Error('应候补');

    c.ticketing.applyPatch({
      orders: [],
      queueStrategy: 'merge-append',
      queues: {
        [rig.trainCode]: [{ id: 'earlier', fromIdx: 0, toIdx: 1, createdAt: 1 }]
      },
      events: []
    });

    const queue = c.ticketing.currentQueues().trains[rig.trainCode] ?? [];
    expect(queue.map((e) => e.id)).toEqual(['earlier', r.ok && !r.issued && r.order ? r.order.id : '']);
  });

  it('orders 按 id upsert：更新既有订单且新增不重复', () => {
    const c = makeContainer();
    const rig = setupRig(c, ['甲站', '乙站'], { seatCount: 2 });
    const r = c.ticketing.purchase(rig.trainCode, 0, 1);
    if (!(r.ok && r.issued)) throw new Error('应出票');
    const before = c.ticketing.currentOrders().length;

    c.ticketing.applyPatch({
      orders: [{ id: r.ok && r.issued ? r.order.id : '', trainCode: rig.trainCode, fromIdx: 0, toIdx: 1, status: OrderStatus.CANCELLED, createdAt: 1 }],
      queueStrategy: 'replace-codes',
      queues: {},
      events: []
    });

    expect(c.ticketing.currentOrders().length).toBe(before); // 不重复
    const updated = c.ticketing.currentOrders().find((o) => o.id === (r.ok && r.issued ? r.order.id : ''));
    expect(updated?.status).toBe(OrderStatus.CANCELLED);
  });
});
