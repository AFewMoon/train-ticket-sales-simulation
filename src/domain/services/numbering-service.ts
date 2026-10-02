/* 号码分配服务：全局唯一 3 位车站号码与唯一车次号的生成、号码池重建。
   教训 #10/#17：takenSet 以 pad3 字符串存储，查询必须同格式（pad3）转换；
   修复比较格式不一致类缺陷时，两端格式化统一收敛到 pad3。 */

import type { IRepository } from '../repository';
import { pad3 } from '../model/primitives';
import { formatStationNo, type Station, type StationNo } from '../model/station';
import type { Line } from '../model/line';
import {
  CODE_FIRST_DIGITS,
  CODE_LAST_DIGITS,
  type Train,
  type TrainCode
} from '../model/train';
import type { SeqPool } from '../../infrastructure/persistence-shapes';

/** 随机取一个未被占用且不在排除集合中的元素；用尽返回 null */
function randomPick(total: number, takenSet: ReadonlySet<string>): number | null {
  const pool: number[] = [];
  for (let i = 0; i < total; i++) if (!takenSet.has(pad3(i))) pool.push(i);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

/** 按位值规则生成随机 4 位数字部分（不接 rng：车次号不参与同种子复现断言） */
function randomCodeNumber(): string {
  const rand = (): number => Math.random();
  const first = CODE_FIRST_DIGITS[Math.floor(rand() * CODE_FIRST_DIGITS.length)] ?? '1';
  const mid1 = Math.floor(rand() * 10);
  const mid2 = Math.floor(rand() * 10);
  const last = CODE_LAST_DIGITS[Math.floor(rand() * CODE_LAST_DIGITS.length)] ?? '1';
  return first + mid1 + mid2 + last;
}

export class NumberingService {
  private seq: SeqPool;

  constructor(
    private readonly stationRepo: IRepository<Station[]>,
    private readonly trainRepo: IRepository<Train[]>,
    private readonly lineRepo: IRepository<Line[]>,
    private readonly seqRepo: IRepository<SeqPool>
  ) {
    this.seq = seqRepo.read();
  }

  private saveSeq(): boolean {
    return this.seqRepo.write(this.seq);
  }

  /** 随机分配全局唯一 3 位车站号码（000-999）；用尽返回 null */
  allocateStationNo(): StationNo | null {
    const used = new Set<string>();
    this.stationRepo.read().forEach((s) => used.add(s.no));
    this.seq.stationNos.forEach((n) => used.add(n));
    const idx = randomPick(1000, used);
    if (idx === null) return null;
    const no = formatStationNo(idx);
    this.seq.stationNos.push(no);
    this.saveSeq();
    return no;
  }

  /** 为车站重新分配不与现有任何车站/号码池冲突的新号码，并同步车次/线路站序引用（数据修复迁移用） */
  reassignStationNo(station: Station): boolean {
    const no = this.allocateStationNo();
    if (no === null) return false;
    const oldNo = station.no;
    const stations = this.stationRepo.read();
    const s = stations.find((x) => x.no === oldNo && x.nameZh === station.nameZh);
    if (!s) return false;
    s.no = no;
    if (!this.stationRepo.write(stations)) return false;

    // 同步所有引用旧号码的站序（车次/线路）
    const trains = this.trainRepo.read();
    let trainsChanged = false;
    trains.forEach((t) => {
      t.stationSeq = t.stationSeq.map((x) => {
        if (x === oldNo) {
          trainsChanged = true;
          return no;
        }
        return x;
      });
    });
    if (trainsChanged) this.trainRepo.write(trains);

    const lines = this.lineRepo.read();
    let linesChanged = false;
    lines.forEach((l) => {
      l.stationSeq = l.stationSeq.map((x) => {
        if (x === oldNo) {
          linesChanged = true;
          return no;
        }
        return x;
      });
      l.majorNos = (l.majorNos ?? []).map((x) => {
        if (x === oldNo) {
          linesChanged = true;
          return no;
        }
        return x;
      });
    });
    if (linesChanged) this.lineRepo.write(lines);
    return true;
  }

  /**
   * 生成唯一车次号：字头 + 4 位数字（首位 1~3/6~8、末位奇数）。
   * prefix 可选（'G' | 'D' | 'K'）：指定时只使用该字头；缺省时随机三选一（手动登记场景）。
   */
  allocateTrainCode(prefix?: string): TrainCode | null {
    const used = new Set<string>();
    this.trainRepo.read().forEach((t) => used.add(t.code));
    this.seq.trainCodes.forEach((c) => used.add(c));
    // 字头池 G/D 等概率（K 字头已退役，v3.1）
    const prefixes: string[] =
      prefix && /^[GD]$/.test(prefix) ? [prefix] : ['G', 'D'];
    for (let attempt = 0; attempt < 5000; attempt++) {
      const p = prefixes[Math.floor(Math.random() * prefixes.length)] ?? 'G';
      const code = p + randomCodeNumber();
      if (!used.has(code)) {
        this.seq.trainCodes.push(code);
        this.saveSeq();
        return code;
      }
    }
    return null;
  }

  /** 测试/修复场景重建号码池（保留当前仍在使用中的号码） */
  rebuildSeqPools(): void {
    this.seq.stationNos = this.stationRepo.read().map((s) => s.no);
    this.seq.trainCodes = this.trainRepo.read().map((t) => t.code);
    this.saveSeq();
  }

  /** 当前号码池快照（自定义车次号唯一性检查用） */
  getSeqPools(): SeqPool {
    return this.seq;
  }

  /** 登记自定义车次号到号码池（占用防复用） */
  registerTrainCode(code: TrainCode): void {
    this.seq.trainCodes.push(code);
    this.saveSeq();
  }
}
