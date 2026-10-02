/* 车次实体与车次号值对象校验。
   车次号规则（教训 #18 语义以停站数约束为准，与本文件无关）：
   字头 G/D/K + 严格 4 位数字——首位 ∈ {1,2,3,6,7,8}，末位为奇数。 */

/** 仿真车次类型 */
export enum SimType {
  Direct = 'direct',
  Express = 'express',
  Skip = 'skip'
}

/** 车次号值对象：G/D/K + 4 位数字（首位 1~3/6~8，末位奇数） */
export type TrainCode = string;

export const CODE_FIRST_DIGITS = ['1', '2', '3', '6', '7', '8'] as const;
export const CODE_LAST_DIGITS = ['1', '3', '5', '7', '9'] as const;
export const CODE_RE = /^[GDK][123678]\d{2}[13579]$/;

export function isValidTrainCode(code: unknown): code is TrainCode {
  return typeof code === 'string' && CODE_RE.test(code);
}

/** 车次字头 */
export type TrainCodePrefix = 'G' | 'D' | 'K';

/** 车次实体（持久化 DTO 与领域模型同形） */
export interface Train {
  code: TrainCode;
  /** 途经车站号码有序序列（挂线时须为线路站序的子序列） */
  stationSeq: string[];
  /** 座位数上限（1 ~ INT_MAX；占用统计只遍历已占用座位，绝不按此枚举） */
  seatCount: number;
  /** 挂接线路 ID */
  lineId?: string;
  /** 仿真车次类型（旧数据可能缺失） */
  simType?: SimType;
  /** 自动仿真生成的车次标记（清理时回收） */
  sim?: boolean;
}

export function trainStationCount(train: Train): number {
  return train.stationSeq.length;
}
