/* 车次领域服务：登记/删除/查询、车次号格式与唯一性校验、线路子序列校验、订单引用禁删。 */

import type { IRepository } from '../repository';
import { err, OK, ok, type Result } from '../model/primitives';
import type { Order } from '../model/order';
import {
  isValidTrainCode,
  type Train,
  type TrainCode
} from '../model/train';
import { isSubsequence } from '../model/line';
import type { LineService } from './line-service';
import type { NumberingService } from './numbering-service';

export class TrainService {
  constructor(
    private readonly trainRepo: IRepository<Train[]>,
    private readonly orderRepo: IRepository<Order[]>,
    private readonly lines: LineService,
    private readonly numbering: NumberingService
  ) {}

  list(): Train[] {
    return this.trainRepo.read();
  }

  get(code: TrainCode): Train | null {
    return this.list().find((t) => t.code === code) ?? null;
  }

  add(
    stationSeq: string[],
    seatCount: number,
    lineId: string | null,
    codePrefix: string | null,
    customCode: string | null
  ): Result<Train> {
    if (!Array.isArray(stationSeq) || stationSeq.length < 2) {
      return err('车次至少需要 2 个途经车站');
    }
    const seen = new Set<string>();
    for (const no of stationSeq) {
      if (seen.has(no)) return err('站序中存在重复车站');
      seen.add(no);
    }
    const seats = Math.floor(Number(seatCount));
    if (!isFinite(seats) || seats < 1 || seats > 2147483647) {
      return err('座位数需为 1 ~ 2147483647 的整数');
    }
    const train: Train = { code: '', stationSeq: stationSeq.slice(), seatCount: seats };
    if (lineId) {
      const line = this.lines.get(lineId);
      if (!line) return err('所挂接的线路不存在');
      if (!isSubsequence(train.stationSeq, line.stationSeq)) {
        return err('车次站序必须是线路「' + line.name + '」站序的子序列（保持相对顺序）');
      }
      train.lineId = lineId;
    }
    let code: TrainCode | null;
    const custom = String(customCode ?? '')
      .trim()
      .toUpperCase();
    if (custom) {
      // 自定义车次号：格式（字头 + 4 位，首位 1~3/6~8、末位奇数）+ 唯一性
      if (!isValidTrainCode(custom)) {
        return err('车次号格式不正确：需为 G/D + 4 位数字（首位 1~3/6~8，末位奇数），如 G1235');
      }
      const usedCheck = new Set<string>();
      this.list().forEach((t) => usedCheck.add(t.code));
      this.numbering.getSeqPools().trainCodes.forEach((c) => usedCheck.add(c));
      if (usedCheck.has(custom)) return err('车次号已存在：' + custom);
      code = custom;
      this.numbering.registerTrainCode(code);
    } else {
      code = this.numbering.allocateTrainCode(codePrefix ?? undefined);
      if (code === null) return err('车次号生成失败');
    }
    train.code = code;
    const trains = this.list();
    trains.push(train);
    if (!this.trainRepo.write(trains)) return err('保存失败');
    return ok(train);
  }

  remove(code: TrainCode): Result {
    const trains = this.list();
    const idx = trains.findIndex((t) => t.code === code);
    if (idx === -1) return err('车次不存在');
    // 含已取消（保留历史）的订单仍引用该车次，禁止删除
    const used = this.orderRepo.read().some((o) => o.trainCode === code);
    if (used) return err('该车次已存在订单，禁止删除');
    trains.splice(idx, 1);
    if (!this.trainRepo.write(trains)) return err('保存失败');
    return OK;
  }

  /**
   * 按号码集合批量移除车次，连带其全部订单（含已取消历史）——
   * 仅供启动数据修复（退役字头清理）使用，绕过「有订单禁删」约束，
   * 因为被移除车次所引用的订单必须一并清除以避免悬空引用。
   */
  removeByCodes(codes: readonly string[]): Train[] {
    if (!codes.length) return [];
    const codeSet = new Set(codes);
    const trains = this.list();
    const removed = trains.filter((t) => codeSet.has(t.code));
    if (!removed.length) return [];
    this.trainRepo.write(trains.filter((t) => !codeSet.has(t.code)));
    const orders = this.orderRepo.read();
    this.orderRepo.write(orders.filter((o) => !codeSet.has(o.trainCode)));
    return removed;
  }
}
