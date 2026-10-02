import { defineConfig } from 'vitest/config';

/**
 * 领域层单测运行于 node 环境：
 * - 存储层通过注入的内存 StorageLike 替代 localStorage，不依赖 DOM。
 * - UI 层（依赖 document）不在单测范围内，浏览器行为由 msedge 回归覆盖。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts']
  }
});
