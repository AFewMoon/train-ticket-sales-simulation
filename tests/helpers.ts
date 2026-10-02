/* 测试辅助：内存存储隔离容器 + 常用数据构造。 */

import { createContainer, type Container } from '../src/container';
import { InMemoryStorage } from '../src/infrastructure/storage';

export function makeContainer(): Container {
  return createContainer(new InMemoryStorage());
}

export interface TestRig {
  nos: string[];
  lineId: string;
  trainCode: string;
}

/** 建车站 → 线路 → 车次（stationNames 顺序即站序） */
export function setupRig(
  c: Container,
  stationNames: string[],
  opts?: { seatCount?: number; majors?: string[] }
): TestRig {
  const nos: string[] = [];
  stationNames.forEach((name, i) => {
    const res = c.stations.add(name, 'S' + i);
    if (!res.ok) throw new Error(res.msg);
    nos.push(res.value.no);
  });
  // 大站参数为站名，转换为站号（站号即线路 majorNos 的存储格式）
  const majorNos = (opts?.majors ?? []).map(
    (name) => nos[stationNames.indexOf(name)] ?? ''
  );
  const line = c.lines.add('测试线-' + stationNames.length + '-' + Math.random().toString(36).slice(2, 6), nos, majorNos);
  if (!line.ok) throw new Error(line.msg);
  const train = c.trains.add(nos, opts?.seatCount ?? 5, line.value.id, 'G', null);
  if (!train.ok) throw new Error(train.msg);
  return { nos, lineId: line.value.id, trainCode: train.value.code };
}
