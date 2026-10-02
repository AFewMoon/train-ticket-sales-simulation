/* 组合根：按依赖方向单向装配（ui → application → domain ← infrastructure）。
   测试可传入 InMemoryStorage 创建隔离容器；浏览器默认 localStorage。 */

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

export interface Container {
  storage: StorageLike;
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
  const orderRepo = new OrderRepository(createRepository(storage, KEYS.orders));
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
  const booking = new BookingAppService(ticketing, trains, stations, lines);

  return { storage, stations, lines, trains, numbering, ticketing, seeder, simulation, booking };
}

let defaultContainer: Container | null = null;

/** 浏览器默认容器（单例） */
export function getContainer(): Container {
  if (!defaultContainer) defaultContainer = createContainer();
  return defaultContainer;
}

/** 测试辅助：重置默认容器 */
export function resetContainer(): void {
  defaultContainer = null;
}
