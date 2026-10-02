import { defineConfig } from 'vitest/config';
import pkg from './package.json';

/** 与 vite.config.ts 同源注入 __APP_VERSION__，保证单测断言真实版本号 */
const { version } = pkg;

/**
 * 领域层单测运行于 node 环境：
 * - 存储层通过注入的内存 StorageLike 替代 localStorage，不依赖 DOM。
 * - UI 层（依赖 document）不在单测范围内，浏览器行为由 msedge 回归覆盖。
 */
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version)
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts']
  }
});
