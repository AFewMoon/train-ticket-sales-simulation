/* 车站实体与 StationNo 值对象。
   StationNo 为 pad3 格式字符串（'000'-'999'），格式化统一经 pad3()，不在此重复实现。 */

import { pad3 } from './primitives';

/** 车站号码值对象：pad3 字符串（'000'-'999'） */
export type StationNo = string;

/** 判断字符串是否为合法车站号码（3 位数字） */
export function isValidStationNo(v: unknown): v is StationNo {
  return typeof v === 'string' && /^\d{3}$/.test(v);
}

export function formatStationNo(n: number): StationNo {
  return pad3(n);
}

/** 车站实体（持久化 DTO 与领域模型同形：纯数据、字段均为可序列化原语） */
export interface Station {
  /** 全局唯一号码（'000'-'999'） */
  no: StationNo;
  /** 中文名（站间唯一，作为去重键） */
  nameZh: string;
  nameEn: string;
  /** 自动仿真生成的车站标记（清理时回收） */
  sim?: boolean;
}
