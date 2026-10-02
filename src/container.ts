/* 组合根：按依赖方向单向装配（ui → application → domain ← infrastructure）。
   测试可传入 InMemoryStorage 创建隔离容器；浏览器默认 localStorage。
   计算网关默认为主线程直算（DirectComputeGateway）；浏览器入口经
   attachWorkerCompute 尝试升级为 Web Worker（失败自动保持直算）。 */

import { createBrowserStorage, type StorageLike } from './infrastructure/storage';
import { KEYS } from './infrastructure/keys';
import { createRepository } from './infrastructure/local-storage-repository';
import { OrderRepository } from './infrastructure/order-repository';
import { NumberingService } from './domain/services/numbering-service';
import { StationService } from './domain/services/station-service';
import { LineService } from './domain/services/line-service';
import { TrainService } from './domain/services/train-service';
import { TicketingService } from './domain/services/ticketing-service';
import { BuiltinSeeder } from './application/builtin-seeder';
import { SimulationService } from './application/simulation-service';
import { BookingAppService } from './application/booking-app-service';
import { EngineTransport } from './application/engine-transport';
import {
  ComputeGatewayHolder,
  DirectComputeGateway
} from './application/compute-gateway';
import { markVersion } from './version';

export interface Container {
  storage: StorageLike;
  transport: EngineTransport;
  /** 计算网关持有者：main.ts 启动时可替换为 Worker 实现 */
  compute: ComputeGatewayHolder;
  stations: StationService;
  lines: LineService;
  trains: TrainService;
  numbering: NumberingService;
  ticketing: TicketingService;
  seeder: BuiltinSeeder;
  simulation: SimulationService;
  booking: BookingAppService;
}

export function createContainer(storage: StorageLike = createBrowserStorage()): Container {
  const stationRepo = createRepository(storage, KEYS.stations);
  const lineRepo = createRepository(storage, KEYS.lines);
  const trainRepo = createRepository(storage, KEYS.trains);
  const orderDtoRepo = createRepository(storage, KEYS.orders);
  const orderRepo = new OrderRepository(orderDtoRepo);
  const queueRepo = createRepository(storage, KEYS.queues);
  const eventRepo = createRepository(storage, KEYS.events);
  const seqRepo = createRepository(storage, KEYS.seq);
  const seededRepo = createRepository(storage, KEYS.seeded);

  const numbering = new NumberingService(stationRepo, trainRepo, lineRepo, seqRepo);
  const stations = new StationService(stationRepo, trainRepo, numbering);
  const lines = new LineService(lineRepo, stationRepo, trainRepo);
  const trains = new TrainService(trainRepo, orderRepo, lines, numbering);
  const ticketing = new TicketingService(orderRepo, trains, queueRepo, eventRepo);
  const seeder = new BuiltinSeeder(stationRepo, lineRepo, seededRepo, stations, lines, numbering);
  const simulation = new SimulationService(
    stationRepo,
    trainRepo,
    lineRepo,
    orderRepo,
    stations,
    lines,
    trains,
    ticketing,
    numbering
  );
  const transport = new EngineTransport(trainRepo, orderDtoRepo, queueRepo, eventRepo, numbering);
  const compute: ComputeGatewayHolder = {
    current: new DirectComputeGateway(ticketing, simulation)
  };
  (globalThis as { __ttsCompute?: string }).__ttsCompute = 'direct';
  markVersion(); // 可观测标记：__ttsVersion（与 __ttsCompute/__ttsStorage 同构）
  const booking = new BookingAppService(ticketing, trains, stations, lines, simulation, compute);

  return { storage, transport, compute, stations, lines, trains, numbering, ticketing, seeder, simulation, booking };
}

let defaultContainer: Container | null = null;

/** 浏览器默认容器注入：IndexedDB 内存镜像就绪后由 main.ts 调用
    （存储初始化是异步的，容器创建必须等镜像预热完成） */
export function initDefaultContainer(storage: StorageLike): Container {
  defaultContainer = createContainer(storage);
  return defaultContainer;
}

/** 浏览器默认容器（单例）。注意：默认走同步 localStorage 降级链，
    主入口（main.ts）应使用 initDefaultContainer 注入 IndexedDB 镜像存储 */
export function getContainer(): Container {
  if (!defaultContainer) defaultContainer = createContainer();
  return defaultContainer;
}

/** 测试辅助：重置默认容器 */
export function resetContainer(): void {
  defaultContainer = null;
}
