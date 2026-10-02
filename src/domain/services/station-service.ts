/* 车站领域服务：登记/删除/查询，唯一性校验与引用禁删规则收敛于此（教训 #7）。 */

import type { IRepository } from '../repository';
import { err, OK, ok, type Result } from '../model/primitives';
import type { Station, StationNo } from '../model/station';
import type { Train } from '../model/train';
import type { NumberingService } from './numbering-service';

export class StationService {
  constructor(
    private readonly stationRepo: IRepository<Station[]>,
    private readonly trainRepo: IRepository<Train[]>,
    private readonly numbering: NumberingService
  ) {}

  list(): Station[] {
    return this.stationRepo.read();
  }

  get(no: StationNo): Station | null {
    return this.list().find((s) => s.no === no) ?? null;
  }

  add(nameZh: string, nameEn: string): Result<Station> {
    const zh = String(nameZh ?? '').trim();
    const en = String(nameEn ?? '').trim();
    if (!zh || !en) return err('中文名与英文名均不能为空');
    const stations = this.list();
    if (stations.some((s) => s.nameZh === zh)) return err('车站中文名已存在：' + zh);
    const no = this.numbering.allocateStationNo();
    if (no === null) return err('车站号码已用尽（000-999）');
    const station: Station = { no, nameZh: zh, nameEn: en };
    stations.push(station);
    if (!this.stationRepo.write(stations)) return err('保存失败');
    return ok(station);
  }

  /** 车站是否被任意车次的站序引用 */
  usedByTrain(no: StationNo): boolean {
    return this.trainRepo.read().some((t) => t.stationSeq.indexOf(no) !== -1);
  }

  remove(no: StationNo): Result {
    const stations = this.list();
    const idx = stations.findIndex((s) => s.no === no);
    if (idx === -1) return err('车站不存在');
    if (this.usedByTrain(no)) return err('该车站已被车次引用，禁止删除');
    stations.splice(idx, 1);
    if (!this.stationRepo.write(stations)) return err('保存失败');
    return OK;
  }
}
