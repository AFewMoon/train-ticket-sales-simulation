/* 线路领域服务：登记/删除/查询、子序列与重复站校验、挂接引用禁删。 */

import type { IRepository } from '../repository';
import { err, OK, ok, uid, type Result } from '../model/primitives';
import type { Line } from '../model/line';
import { isSubsequence } from '../model/line';
import type { Station } from '../model/station';
import type { Train } from '../model/train';

export interface LineCreateFlags {
  builtin?: boolean;
  sim?: boolean;
}

export class LineService {
  constructor(
    private readonly lineRepo: IRepository<Line[]>,
    private readonly stationRepo: IRepository<Station[]>,
    private readonly trainRepo: IRepository<Train[]>
  ) {}

  list(): Line[] {
    return this.lineRepo.read();
  }

  get(id: string): Line | null {
    return this.list().find((l) => l.id === id) ?? null;
  }

  add(
    name: string,
    stationSeq: string[],
    majorNos: string[] | null,
    flags?: LineCreateFlags
  ): Result<Line> {
    const nameTrimmed = String(name ?? '').trim();
    if (!nameTrimmed) return err('线路名称不能为空');
    if (!Array.isArray(stationSeq) || stationSeq.length < 2) {
      return err('线路至少需要 2 个途经车站');
    }
    const seen = new Set<string>();
    for (const no of stationSeq) {
      if (seen.has(no)) return err('线路站序中存在重复车站');
      seen.add(no);
    }
    const knownStations = new Map<string, Station>();
    this.stationRepo.read().forEach((s) => knownStations.set(s.no, s));
    for (const no of stationSeq) {
      if (!knownStations.has(no)) return err('站序中包含未登记的车站');
    }
    let majors = (Array.isArray(majorNos) ? majorNos : []).filter((no) => seen.has(no));
    if (!majors.length) {
      // 未指定大站时默认首末站为大站
      majors = [stationSeq[0] ?? '', stationSeq[stationSeq.length - 1] ?? ''];
    }
    if (this.list().some((l) => l.name === nameTrimmed)) {
      return err('线路名称已存在：' + nameTrimmed);
    }
    const line: Line = {
      id: uid('l'),
      name: nameTrimmed,
      stationSeq: stationSeq.slice(),
      majorNos: majors,
      ...(flags?.builtin ? { builtin: true } : {}),
      ...(flags?.sim ? { sim: true } : {})
    };
    const lines = this.list();
    lines.push(line);
    if (!this.lineRepo.write(lines)) return err('保存失败');
    return ok(line);
  }

  /** 线路是否被车次挂接引用 */
  usedByTrain(lineId: string): boolean {
    return this.trainRepo.read().some((t) => t.lineId === lineId);
  }

  remove(id: string): Result {
    const lines = this.list();
    const idx = lines.findIndex((l) => l.id === id);
    if (idx === -1) return err('线路不存在');
    if (this.usedByTrain(id)) return err('该线路已被车次挂接，禁止删除');
    lines.splice(idx, 1);
    if (!this.lineRepo.write(lines)) return err('保存失败');
    return OK;
  }
}

export { isSubsequence };
