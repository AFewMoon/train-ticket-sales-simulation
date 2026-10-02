import { defineConfig } from 'vite';

/**
 * IIFE 单文件 bundle：
 * - ES modules 在 file:// 协议下因 CORS 无法运行，IIFE 产物保留「双击 index.html 即可运行」的项目性质。
 * - 输出 dist/train-ticket-sales.js，index.html 以普通 <script> 引用。
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main.ts',
      formats: ['iife'],
      name: 'TTS',
      fileName: () => 'train-ticket-sales.js'
    },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020'
  },
  worker: {
    // 计算引擎 Worker 内联为 blob（IIFE 格式），保证 file:// 直开与单文件产物自包含
    format: 'iife'
  }
});
