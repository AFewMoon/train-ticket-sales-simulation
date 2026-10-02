import { describe, it, expect } from 'vitest';
import { APP_VERSION, markVersion } from '../src/version';

describe('版本标记', () => {
  it('APP_VERSION 为语义化版本号（package.json 构建期注入）', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('markVersion 登记 globalThis.__ttsVersion（与 __ttsCompute/__ttsStorage 同构）', () => {
    markVersion();
    expect((globalThis as { __ttsVersion?: string }).__ttsVersion).toBe(APP_VERSION);
  });

  it('markVersion 幂等可重复调用', () => {
    markVersion();
    markVersion();
    expect((globalThis as { __ttsVersion?: string }).__ttsVersion).toBe(APP_VERSION);
  });
});
