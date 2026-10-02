/* 应用版本标记：版本号唯一来源为 package.json，构建期经 vite/vitest 的 define
   注入 __APP_VERSION__（无手动同步点）。与 __ttsCompute / __ttsStorage 同构，
   供浏览器回归断言与用户问题排查（「你跑的是哪一版」可由控制台直接回答）。 */

declare const __APP_VERSION__: string;

/** 语义化版本号；未注入环境（如裸 tsc）降级为 'dev' */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

/** 组合根创建容器时登记 globalThis.__ttsVersion（幂等，可重复调用） */
export function markVersion(): void {
  (globalThis as { __ttsVersion?: string }).__ttsVersion = APP_VERSION;
}
