/* 计算引擎 Worker 入口：纯 RPC 分发，无状态、无持久化。
   引擎函数为纯数据运算（快照进/补丁出），Worker 内无 localStorage/DOM 依赖。 */

/// <reference lib="webworker" />
import { handleEngineRequest } from '../domain/engine/dispatch';
import type { EngineRequest } from '../domain/engine/protocol';

self.onmessage = (e: MessageEvent<EngineRequest>) => {
  (self as DedicatedWorkerGlobalScope).postMessage(handleEngineRequest(e.data));
};
