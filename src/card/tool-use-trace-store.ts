/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Runtime store for structured tool-use steps.
 *
 * The Feishu card renderer reads from this store by session key so it can
 * render observable, replayable tool execution without relying purely on
 * reply payload text.
 */

import { normalizeToolName, redactInlineSecrets, truncateText } from './reasoning-utils';

export interface ToolUseTraceStep {
  id: string;
  seq: number;
  toolName: string;
  toolCallId?: string;
  runId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt?: number;
}

interface SessionTraceState {
  nextSeq: number;
  updatedAt: number;
  steps: ToolUseTraceStep[];
  currentRunId: string | undefined;
}

const TRACE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSION_TRACES = 128;
const MAX_STEPS_PER_SESSION = 256;
const STEP_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;
const GENERIC_STRING_LIMIT = 512;
const RESULT_STRING_LIMIT = 1024;
const COMMAND_STRING_LIMIT = 4096;
const PATH_STRING_LIMIT = 2048;
const sessionTraces = new Map<string, SessionTraceState>();

export function startToolUseTraceRun(sessionKey: string): void {
  if (!sessionKey) return;
  pruneTraceStore();
  sessionTraces.set(sessionKey, {
    nextSeq: 1,
    updatedAt: Date.now(),
    steps: [],
    currentRunId: undefined,
  });
}

export function clearToolUseTraceRun(sessionKey: string): void {
  if (!sessionKey) return;
  sessionTraces.delete(sessionKey);
}

export function hasToolUseTraceRun(sessionKey?: string): boolean {
  if (!sessionKey) return false;
  return sessionTraces.has(sessionKey);
}

export function recordToolUseStart(params: {
  sessionKey?: string;
  toolName: string;
  toolParams?: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
}): void {
  const { sessionKey, toolName, toolParams, toolCallId, runId } = params;
  if (!sessionKey || !toolName) return;

  const state = sessionTraces.get(sessionKey);
  if (!state) return;

  if (runId) {
    if (state.currentRunId === undefined) {
      state.currentRunId = runId;
    } else if (state.currentRunId !== runId) {
      return;
    }
  }

  const now = Date.now();

  // 去重：若已存在相同 toolCallId，或相同工具名在 running 状态且参数/时间相近的步骤，原地更新避免重复插入
  const sanitizedParams = sanitizeTraceValue(toolParams, 0, { source: 'params' }) as
    | Record<string, unknown>
    | undefined;
  if (toolCallId) {
    for (let index = state.steps.length - 1; index >= 0; index -= 1) {
      const step = state.steps[index];
      if (step && step.toolCallId === toolCallId) {
        if (!step.params && sanitizedParams) step.params = sanitizedParams;
        if (runId && !step.runId) step.runId = runId;
        state.updatedAt = now;
        return;
      }
    }
  }

  const normalizedToolName = normalizeToolName(toolName);
  const paramsKey = fingerprintTraceValue(sanitizedParams);
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const step = state.steps[index];
    if (!step || step.status !== 'running') continue;
    // 若两边都有不同的 toolCallId，说明是不同的并发调用，不能去重
    if (step.toolCallId && toolCallId && step.toolCallId !== toolCallId) continue;
    if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
    // 仅在 5 秒内的同名调用去重，防止混淆跨轮次步骤
    if (now - step.startedAt > 5000) continue;
    if (fingerprintTraceValue(step.params) === paramsKey || !step.params || !sanitizedParams) {
      if (toolCallId && !step.toolCallId) step.toolCallId = toolCallId;
      if (runId && !step.runId) step.runId = runId;
      if (!step.params && sanitizedParams) step.params = sanitizedParams;
      state.updatedAt = now;
      return;
    }
  }

  if (state.steps.length >= MAX_STEPS_PER_SESSION) {
    state.steps.splice(0, state.steps.length - MAX_STEPS_PER_SESSION + 1);
  }
  state.steps.push({
    id: `${state.nextSeq}`,
    seq: state.nextSeq,
    toolName,
    toolCallId: toolCallId || undefined,
    runId: runId || undefined,
    params: sanitizedParams,
    status: 'running',
    startedAt: now,
  });
  state.nextSeq += 1;
  state.updatedAt = now;
}

export function recordToolUseEnd(params: {
  sessionKey?: string;
  toolName: string;
  toolParams?: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}): void {
  const { sessionKey, toolName, toolParams, toolCallId, runId, result, error, durationMs } = params;
  if (!sessionKey) return;
  if (!toolName && !toolCallId) return;

  const state = sessionTraces.get(sessionKey);
  if (!state) return;

  if (runId && state.currentRunId !== undefined && state.currentRunId !== runId) {
    return;
  }

  const now = Date.now();
  const sanitizedParams = sanitizeTraceValue(toolParams, 0, { source: 'params' }) as
    | Record<string, unknown>
    | undefined;
  const pendingIndex = findPendingStepIndex(state.steps, toolName, sanitizedParams, toolCallId);

  if (pendingIndex >= 0) {
    const step = state.steps[pendingIndex];
    if (!step) return;
    step.status = error ? 'error' : 'success';
    step.result = sanitizeTraceValue(result, 0, { source: 'result' });
    step.error = error ? truncateText(error, 160) : undefined;
    step.durationMs = durationMs ?? Math.max(0, now - step.startedAt);
    step.finishedAt = now;
    if (!step.params && sanitizedParams) {
      step.params = sanitizedParams;
    }
    state.updatedAt = now;
    return;
  }

  // 去重：end 事件可能没有匹配中的 running 步骤（start 丢失、重复 end、trace 中途被清）。
  // 盲目追加会在卡片上产生重复行（生产实测「同一条命令出现两条 Running」的来源之一）。
  // 先按 toolCallId / 同名同参数指纹找已有步骤原地更新，实在匹配不到才追加。
  if (toolCallId) {
    for (let index = state.steps.length - 1; index >= 0; index -= 1) {
      const step = state.steps[index];
      if (step && step.toolCallId === toolCallId) {
        step.status = error ? 'error' : 'success';
        step.result = sanitizeTraceValue(result, 0, { source: 'result' });
        step.error = error ? truncateText(error, 160) : undefined;
        step.durationMs = durationMs ?? step.durationMs ?? Math.max(0, now - step.startedAt);
        step.finishedAt = now;
        state.updatedAt = now;
        return;
      }
    }
  }

  const endParamsKey = fingerprintTraceValue(sanitizedParams);
  const endToolName = toolName ? normalizeToolName(toolName) : '';
  if (endToolName) {
    for (let index = state.steps.length - 1; index >= 0; index -= 1) {
      const step = state.steps[index];
      if (!step || step.status === 'running') continue;
      if (normalizeToolName(step.toolName) !== endToolName) continue;
      if (fingerprintTraceValue(step.params) !== endParamsKey) continue;
      // 只吸收 10 秒内的重复 end：更早的同名步骤大概率是另一次真实调用
      if (now - (step.finishedAt ?? step.startedAt) > 10_000) break;
      step.status = error ? 'error' : 'success';
      step.result = sanitizeTraceValue(result, 0, { source: 'result' });
      step.error = error ? truncateText(error, 160) : undefined;
      step.durationMs = durationMs ?? step.durationMs ?? Math.max(0, now - step.startedAt);
      step.finishedAt = now;
      state.updatedAt = now;
      return;
    }
  }

  state.steps.push({
    id: `${state.nextSeq}`,
    seq: state.nextSeq,
    toolName,
    toolCallId: toolCallId || undefined,
    runId: runId || undefined,
    params: sanitizedParams,
    result: sanitizeTraceValue(result, 0, { source: 'result' }),
    error: error ? truncateText(error, 160) : undefined,
    durationMs,
    status: error ? 'error' : 'success',
    startedAt: now,
    finishedAt: now,
  });
  state.nextSeq += 1;
  state.updatedAt = now;
}

export function getToolUseTraceSteps(sessionKey?: string): ToolUseTraceStep[] {
  if (!sessionKey) return [];
  const state = sessionTraces.get(sessionKey);
  if (!state) return [];
  if (Date.now() - state.updatedAt > TRACE_TTL_MS) {
    sessionTraces.delete(sessionKey);
    return [];
  }
  const now = Date.now();
  return state.steps.map((step) => {
    if (step.status === 'running' && now - step.startedAt > STEP_RUNNING_TIMEOUT_MS) {
      return { ...step, status: 'error' as const, error: 'timed out', finishedAt: now };
    }
    return { ...step };
  });
}

function findPendingStepIndex(
  steps: ToolUseTraceStep[],
  toolName: string,
  params?: Record<string, unknown>,
  toolCallId?: string,
): number {
  if (toolCallId) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (!step || step.status !== 'running') continue;
      if (step.toolCallId === toolCallId) return index;
    }
  }

  // End events may omit the tool name entirely; fall back to the most
  // recent running step so status never gets stuck on "running".
  const normalizedToolName = toolName ? normalizeToolName(toolName) : '';
  if (!normalizedToolName) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step && step.status === 'running') return index;
    }
    return -1;
  }

  const paramsKey = fingerprintTraceValue(params);

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.status !== 'running') continue;
    if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
    if (fingerprintTraceValue(step.params) !== paramsKey) continue;
    return index;
  }

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.status !== 'running') continue;
    if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
    return index;
  }

  return -1;
}

function pruneTraceStore(): void {
  const now = Date.now();
  for (const [sessionKey, state] of sessionTraces) {
    if (now - state.updatedAt > TRACE_TTL_MS) {
      sessionTraces.delete(sessionKey);
    }
  }

  if (sessionTraces.size <= MAX_SESSION_TRACES) return;

  const overflow = sessionTraces.size - MAX_SESSION_TRACES;
  const entries = [...sessionTraces.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [sessionKey] of entries.slice(0, overflow)) {
    sessionTraces.delete(sessionKey);
  }
}

export function sanitizeTraceValue(
  value: unknown,
  depth = 0,
  context: { source?: 'params' | 'result' | 'generic'; key?: string } = {},
): unknown {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const limit = resolveStringLimit(context);
    return truncateText(sanitizeTraceString(value, context), limit);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 2) return '[truncated]';

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeTraceValue(item, depth + 1, { source: context.source }));
  }

  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, entryValue] of Object.entries(input).slice(0, 12)) {
      output[key] = isSensitiveKey(key)
        ? '[redacted]'
        : sanitizeTraceValue(entryValue, depth + 1, { source: context.source, key });
    }

    return output;
  }

  return truncateText(String(value), 180);
}

function sanitizeTraceString(
  value: string,
  context: { source?: 'params' | 'result' | 'generic'; key?: string },
): string {
  const redactedUrl = redactUrlParams(value);
  if (isCommandLikeKey(context.key)) {
    return redactInlineSecrets(redactedUrl);
  }
  return redactedUrl;
}

function resolveStringLimit(context: { source?: 'params' | 'result' | 'generic'; key?: string }): number {
  const key = context.key?.toLowerCase() ?? '';
  if (/(?:^|_)(?:command|script|description|prompt|task)(?:$|_)/.test(key)) {
    return COMMAND_STRING_LIMIT;
  }
  if (/(?:^|_)(?:path|file|url|uri|cwd|folder|dir)(?:$|_)/.test(key)) {
    return PATH_STRING_LIMIT;
  }
  if (context.source === 'result') {
    return RESULT_STRING_LIMIT;
  }
  return GENERIC_STRING_LIMIT;
}

function isCommandLikeKey(key?: string): boolean {
  const normalized = key?.toLowerCase() ?? '';
  return /(?:^|_)(?:command|script)(?:$|_)/.test(normalized);
}

const SENSITIVE_KEY_RE =
  /secret|token|password|authorization|cookie|api[-_]?key|credential|private[-_]?key|access[-_]?key|database[-_]?url|connection[-_]?string|bearer|signing[-_]?key|encryption[-_]?key|session[-_]?id|client[-_]?secret|auth[-_]?token/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function redactUrlParams(url: string): string {
  return url.replace(/([?&])(api_key|token|secret|key)=[^&]*/gi, '$1$2=[redacted]');
}

function fingerprintTraceValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  return JSON.stringify(sortTraceValue(value));
}

function sortTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortTraceValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortTraceValue(entryValue)]),
    );
  }
  return value;
}

/** @internal — test-only helper to reset module-level state between test cases. */
export function _resetForTesting(): void {
  sessionTraces.clear();
}
