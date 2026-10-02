/* 线路实体与子序列校验。 */

/** 判断 sub 是否为 full 的子序列（保持相对顺序，可跳过元素） */
export function isSubsequence(sub: readonly string[], full: readonly string[]): boolean {
  if (!Array.isArray(sub) || !Array.isArray(full)) return false;
  let j = 0;
  for (let i = 0; i < full.length && j < sub.length; i++) {
    if (full[i] === sub[j]) j++;
  }
  return j === sub.length;
}

/** 线路实体（持久化 DTO 与领域模型同形） */
export interface Line {
  id: string;
  name: string;
  /** 途经车站号码有序序列（起点 → 终点，站号全局唯一故无重复） */
  stationSeq: string[];
  /** 大站号码集合（⊆ stationSeq） */
  majorNos: string[];
  /** 内置「四纵四横」线路标记 */
  builtin?: boolean;
  /** 自动仿真生成的线路标记（清理时回收） */
  sim?: boolean;
}

/** 站号是否为该线路的大站 */
export function isMajorStation(line: Line, no: string): boolean {
  return (line.majorNos ?? []).indexOf(no) !== -1;
}
