/* 购票应用服务：购票/退票/退票模拟/仿真用例编排 + UI 渲染就绪 ViewModel 计算。
   重度计算经 ComputeGateway 发起（Web Worker 优先，主线程直算回退）；
   原 ui.js 中的业务计算（退票模拟、座位图几何、候补名次、区间覆盖查询）全部下沉至此，
   UI 层只消费本服务返回的视图数据（教训 #5：分层让验证与修错成本大幅降低）。 */

import type { StationService } from '../domain/services/station-service';
import type { LineService } from '../domain/services/line-service';
import type { TrainService } from '../domain/services/train-service';
import type { TicketingService, PurchaseResult, RefundResult } from '../domain/services/ticketing-service';
import { groupBySeat } from '../domain/services/ticketing-service';
import { OrderStatus } from '../domain/model/order';
import { coversSegment } from '../domain/model/seat-segment';
import { isMajorStation } from '../domain/model/line';
import { SimType, type Train } from '../domain/model/train';
import { TYPE_META, typeOfTrain, type SimulationResult } from './simulation-service';
import type { SimulationService } from './simulation-service';
import type { SimulationConfig } from '../domain/engine/protocol';
import type { ComputeGatewayHolder } from './compute-gateway';
import type {
  CapacityHintView,
  OrderRowView,
  QueryResultView,
  QueryRowView,
  SeatRowView,
  SeatSegView,
  AxisTickView,
  TrainSeatMapModel,
  WaitingItemView
} from './view-models';

const UNKNOWN_STATION = '未知站';

function statusLabelOf(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.ISSUED:
      return '已出票';
    case OrderStatus.CANCELLED:
      return '已取消';
    default:
      return '候补中';
  }
}

export class BookingAppService {
  constructor(
    private readonly ticketing: TicketingService,
    private readonly trains: TrainService,
    private readonly stations: StationService,
    private readonly lines: LineService,
    private readonly simulation: SimulationService,
    private readonly compute: ComputeGatewayHolder
  ) {}

  /** 购票：重度计算经网关发起（Worker 优先），补丁落盘后返回结果 */
  async purchase(trainCode: string, fromIdx: number, toIdx: number): Promise<PurchaseResult> {
    return this.compute.current.purchase(trainCode, fromIdx, toIdx);
  }

  /** 退票 / 取消候补（CANCELLED 语义） */
  async refundOrder(orderId: string): Promise<RefundResult> {
    return this.compute.current.refundOrder(orderId);
  }

  hasIssuedOrders(): boolean {
    return this.ticketing.currentOrders().some((o) => o.status === OrderStatus.ISSUED);
  }

  /**
   * 退票模拟：按比率随机抽单退票，候补自动按时间戳补录。
   * 批量运算经网关发起（Worker 内全内存完成，主线程只收补丁）。
   */
  async refundSimulation(ratePercent: number): Promise<{ ok: false; msg: string } | { ok: true; refunded: number; fulfilled: number }> {
    return this.compute.current.refundSimulation(ratePercent);
  }

  /**
   * 仿真：prepare 在主线程解析（auto 线路创建为轻量 CRUD），
   * 批量生成与批量购票经网关发起。
   */
  async runSimulation(cfg: SimulationConfig): Promise<SimulationResult> {
    const prepared = this.simulation.prepare(cfg);
    if (!prepared.ok) return prepared;
    return this.compute.current.simulateResolved(prepared.line, prepared.cfg);
  }

  /* ---------- ViewModel ---------- */

  stationName(no: string | undefined): string {
    if (!no) return UNKNOWN_STATION;
    const s = this.stations.get(no);
    return s ? s.nameZh : no;
  }

  /** 购票页容量提示文案 */
  capacityHint(code: string): CapacityHintView {
    const train = code ? this.trains.get(code) : null;
    if (!train) return { text: '请选择车次', hasTrain: false };
    const orders = this.ticketing.ordersOfTrain(code);
    const overview = this.ticketing.capacityOverview(train, orders);
    return {
      hasTrain: true,
      text:
        train.code +
        '：' +
        train.seatCount +
        ' 座，共 ' +
        overview.summary.totalSegments +
        ' 个区间段，剩余空闲区间段 ' +
        overview.summary.freeSegments +
        ' 个；已出票 ' +
        overview.issuedCount +
        ' 单，候补 ' +
        overview.waitingCount +
        ' 单'
    };
  }

  /** 全部候补订单（按时间戳），按车次分组显示名次 */
  waitingList(): WaitingItemView[] {
    const waiting = this.ticketing
      .allWaitingOrders()
      .sort((a, b) => a.createdAt - b.createdAt);
    const counters = new Map<string, number>();
    return waiting.map((o) => {
      const rank = (counters.get(o.trainCode) ?? 0) + 1;
      counters.set(o.trainCode, rank);
      const train = this.trains.get(o.trainCode);
      const st = train ? train.stationSeq : [];
      return {
        trainCode: o.trainCode,
        fromLabel: this.stationName(st[o.fromIdx]),
        toLabel: this.stationName(st[o.toIdx]),
        position: rank
      };
    });
  }

  /** 订单列表行（含取消状态与新退票语义的按钮文案） */
  orderRows(): OrderRowView[] {
    return this.ticketing
      .currentOrders()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((o) => {
        const train = this.trains.get(o.trainCode);
        const st = train ? train.stationSeq : [];
        return {
          id: o.id,
          trainCode: o.trainCode,
          fromLabel: this.stationName(st[o.fromIdx]),
          toLabel: this.stationName(st[o.toIdx]),
          status: o.status,
          statusLabel: statusLabelOf(o.status),
          seatLabel: o.seatNo !== null ? '第 ' + o.seatNo + ' 号座位' : '—',
          refundable: o.status !== OrderStatus.CANCELLED,
          refundLabel: o.status === OrderStatus.ISSUED ? '退票' : '取消候补'
        };
      });
  }

  /** 单趟车次的座位区间图模型（只含已出票订单；未占用座位不渲染，教训 #20） */
  seatMapForTrain(train: Train): TrainSeatMapModel | null {
    const issued = this.ticketing
      .ordersOfTrain(train.code)
      .filter((o) => o.status === OrderStatus.ISSUED);
    if (!issued.length) return null;

    const S = train.stationSeq.length;
    const line = train.lineId ? this.lines.get(train.lineId) : null;
    const simType = typeOfTrain(train);
    const meta = simType !== null ? TYPE_META[simType] : null;

    // 已占用座位集合（升序）
    const seatNos = Array.from(groupBySeat(issued).keys()).sort((a, b) => a - b);

    const rows: SeatRowView[] = seatNos.map((seat) => {
      const segs: SeatSegView[] = issued
        .filter((o) => o.seatNo === seat)
        .sort((a, b) => a.fromIdx - b.fromIdx)
        .map((o, idx) => ({
          leftPct: (o.fromIdx / (S - 1)) * 100,
          widthPct: ((o.toIdx - o.fromIdx) / (S - 1)) * 100,
          fromLabel: this.stationName(train.stationSeq[o.fromIdx]),
          toLabel: this.stationName(train.stationSeq[o.toIdx]),
          orderId: o.id,
          segIndex: idx
        }));
      return { seatNo: seat, segs };
    });

    // 停站轴（大站加 ★）
    const axis: AxisTickView[] = [];
    for (let i = 0; i < S; i++) {
      const no = train.stationSeq[i];
      const name = this.stationName(no) + (line && isMajorStation(line, no ?? '') ? '★' : '');
      const pos = (i / (S - 1)) * 100;
      axis.push({
        label: name,
        align: i === 0 ? '0' : i === S - 1 ? '100%' : pos + '%',
        transform: i === 0 ? 'translateX(0)' : i === S - 1 ? 'translateX(-100%)' : 'translateX(-50%)'
      });
    }

    return {
      code: train.code,
      typeName: meta ? meta.label : null,
      typeBadge: meta ? meta.badge : null,
      lineName: line ? line.name : null,
      stationCount: S,
      rows,
      axis
    };
  }

  /** 全部有出票订单的车次座位图 */
  seatMaps(): TrainSeatMapModel[] {
    const models: TrainSeatMapModel[] = [];
    this.trains.list().forEach((train) => {
      const m = this.seatMapForTrain(train);
      if (m) models.push(m);
    });
    return models;
  }

  /** 数据查询区视图：全部订单 / 指定相邻段上的已出票订单 */
  queryResult(trainCode: string, segIdx: number): QueryResultView {
    const train = this.trains.get(trainCode);
    if (!train) return { kind: 'no-train' };

    if (segIdx < 0) {
      const rows = this.ticketing
        .ordersOfTrain(train.code)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((o) => this.orderToRow(train, o));
      return { kind: 'all', rows };
    }

    // 该相邻区间段上的已出票订单（旅程覆盖该段）
    const rows = this.ticketing
      .ordersOfTrain(train.code)
      .filter((o) => o.status === OrderStatus.ISSUED && coversSegment(o, segIdx))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((o) => this.orderToRow(train, o));
    const title =
      this.stationName(train.stationSeq[segIdx]) +
      ' — ' +
      this.stationName(train.stationSeq[segIdx + 1]) +
      ' 段';
    return { kind: 'segment', title, rows };
  }

  private orderToRow(
    train: Train,
    o: { fromIdx: number; toIdx: number; status: OrderStatus; seatNo: number | null }
  ): QueryRowView {
    const st = train.stationSeq;
    return {
      fromLabel: this.stationName(st[o.fromIdx]),
      toLabel: this.stationName(st[o.toIdx]),
      status: o.status,
      statusLabel: statusLabelOf(o.status),
      seatLabel: o.seatNo !== null ? '第 ' + o.seatNo + ' 号座位' : '—'
    };
  }

  /** 车次类型徽章（仿真摘要表用） */
  simTypeMeta(simType: SimType | null): { typeName: string | null; typeBadge: string | null } {
    if (simType === null) return { typeName: null, typeBadge: null };
    const meta = TYPE_META[simType];
    return meta ? { typeName: meta.label, typeBadge: meta.badge } : { typeName: null, typeBadge: null };
  }
}
