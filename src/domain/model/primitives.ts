/* 基础原语：ID 生成、车站号码格式化（唯一格式化来源）、通用结果类型。
   教训 #10/#17：所有号码比较必须经 pad3 收敛，禁止散落 String(n)。 */

/** 生成带前缀的唯一 ID（非严格 UUID，够用于本地模拟） */
export function uid(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 3 位号码格式化：'000'-'999'。所有站号比较/集合成员判断的唯一格式化入口 */
export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** 通用操作结果：成功携带值，失败携带用户可读消息（UI 只展示 msg） */
export type Result<T = void> = { ok: true; value: T } | { ok: false; msg: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export const OK: Result<void> = { ok: true, value: undefined };

export function err<T = void>(msg: string): Result<T> {
  return { ok: false, msg };
}
