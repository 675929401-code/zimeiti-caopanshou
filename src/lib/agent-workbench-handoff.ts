import type { StructuredAgentOutputReadyDetail } from "@/lib/structured-agent-output";
import { createUserScopedWorkbenchStorage, readBrowserWorkbenchIdentity } from "@/lib/workbench-user-storage";
import { parseStoryboardCanvasImport } from "@/lib/storyboard-canvas-bridge";

export const AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION = "agent_workbench_handoff.v1";
export const AGENT_WORKBENCH_HANDOFF_TTL_MS = 2 * 60 * 1_000;

export type AgentWorkbenchHandoffTarget = "storyboard-workbench" | "canvas" | "film-studio";

export interface AgentWorkbenchHandoffEnvelope {
  schema_version: typeof AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION;
  artifact_type: "agent_workbench_handoff";
  handoff_id: string;
  source_route: "/tools/text/text-chat";
  target: AgentWorkbenchHandoffTarget;
  created_at: string;
  expires_at: string;
  payload: StructuredAgentOutputReadyDetail;
}

export interface AgentWorkbenchHandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AgentWorkbenchHandoffReadResult =
  | { ok: true; handoff: AgentWorkbenchHandoffEnvelope }
  | {
      ok: false;
      code: "MISSING" | "INVALID" | "EXPIRED" | "TARGET_MISMATCH" | "STORAGE_UNAVAILABLE";
      error: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserSessionStorage(
  storage?: AgentWorkbenchHandoffStorage,
  target?: AgentWorkbenchHandoffTarget,
): AgentWorkbenchHandoffStorage | null {
  if (typeof window !== "undefined" && target) {
    try {
      const legacyKey = agentWorkbenchHandoffStorageKey(target);
      const legacyRaw = window.sessionStorage.getItem(legacyKey);
      window.sessionStorage.removeItem(legacyKey);
      clearLegacyReceipt(window.sessionStorage, target, legacyRaw);
    } catch {
      // Legacy unscoped bytes are ignored when browser storage is unavailable.
    }
  }
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    const identity = readBrowserWorkbenchIdentity();
    return identity ? createUserScopedWorkbenchStorage(window.sessionStorage, identity.userId) : null;
  } catch {
    return null;
  }
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 220);
}

export function agentWorkbenchHandoffStorageKey(target: AgentWorkbenchHandoffTarget): string {
  return `agent_workbench_handoff_v1:${target}`;
}

function legacyAgentWorkbenchHandoffReceiptKey(
  target: AgentWorkbenchHandoffTarget,
  handoffId: string,
): string {
  return `agent_workbench_handoff_receipt_v1:${target}:${safeToken(handoffId)}`;
}

export function createAgentWorkbenchHandoff(
  detail: StructuredAgentOutputReadyDetail,
  target: AgentWorkbenchHandoffTarget,
  nowMs = Date.now(),
): AgentWorkbenchHandoffEnvelope | null {
  if (!detail.commit_key.trim() || !detail.message_id.trim()) return null;
  if (!parseStoryboardCanvasImport(detail)) return null;
  const createdAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + AGENT_WORKBENCH_HANDOFF_TTL_MS);
  return {
    schema_version: AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION,
    artifact_type: "agent_workbench_handoff",
    handoff_id: safeToken(`${target}:${detail.commit_key}`),
    source_route: "/tools/text/text-chat",
    target,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    payload: detail,
  };
}

export function saveAgentWorkbenchHandoff(
  detail: StructuredAgentOutputReadyDetail,
  target: AgentWorkbenchHandoffTarget,
  storage?: AgentWorkbenchHandoffStorage,
): AgentWorkbenchHandoffEnvelope | null {
  const targetStorage = browserSessionStorage(storage, target);
  const envelope = createAgentWorkbenchHandoff(detail, target);
  if (!targetStorage || !envelope) return null;
  try {
    const key = agentWorkbenchHandoffStorageKey(target);
    clearLegacyReceipt(targetStorage, target, targetStorage.getItem(key));
    targetStorage.setItem(key, JSON.stringify(envelope));
    return envelope;
  } catch {
    return null;
  }
}

export function parseAgentWorkbenchHandoff(
  raw: string | null,
  expectedTarget: AgentWorkbenchHandoffTarget,
  options: { nowMs?: number } = {},
): AgentWorkbenchHandoffReadResult {
  if (!raw) return { ok: false, code: "MISSING", error: "未找到 Agent 交接内容，请返回创作 Agent 重新点击交接。" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID", error: "Agent 交接内容已损坏，未执行导入。" };
  }
  if (!isRecord(value)
    || value.schema_version !== AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION
    || value.artifact_type !== "agent_workbench_handoff"
    || typeof value.handoff_id !== "string"
    || typeof value.source_route !== "string"
    || typeof value.target !== "string"
    || typeof value.created_at !== "string"
    || typeof value.expires_at !== "string"
    || !isRecord(value.payload)) {
    return { ok: false, code: "INVALID", error: "Agent 交接协议不完整，未执行导入。" };
  }
  if (value.target !== expectedTarget) {
    return { ok: false, code: "TARGET_MISMATCH", error: "Agent 交接目标与当前工作台不一致，未执行导入。" };
  }
  const nowMs = options.nowMs ?? Date.now();
  const createdAt = Date.parse(value.created_at);
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || createdAt > nowMs || expiresAt <= nowMs
    || expiresAt - createdAt <= 0 || expiresAt - createdAt > AGENT_WORKBENCH_HANDOFF_TTL_MS) {
    return { ok: false, code: "EXPIRED", error: "Agent 交接已过期，请返回创作 Agent 重新确认。" };
  }
  const envelope = value as unknown as AgentWorkbenchHandoffEnvelope;
  if (!parseStoryboardCanvasImport(envelope.payload)) {
    return { ok: false, code: "INVALID", error: "Agent 交接中的分镜机器包未通过校验，未执行导入。" };
  }
  return { ok: true, handoff: envelope };
}

function clearLegacyReceipt(
  storage: AgentWorkbenchHandoffStorage,
  target: AgentWorkbenchHandoffTarget,
  raw: string | null,
): void {
  if (!raw) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.handoff_id === "string") {
      storage.removeItem(legacyAgentWorkbenchHandoffReceiptKey(target, value.handoff_id));
    }
  } catch {
    // The payload key is still deleted even when legacy bytes are malformed.
  }
}

export function readAgentWorkbenchHandoff(
  target: AgentWorkbenchHandoffTarget,
  storage?: AgentWorkbenchHandoffStorage,
  nowMs = Date.now(),
): AgentWorkbenchHandoffReadResult {
  const targetStorage = browserSessionStorage(storage, target);
  if (!targetStorage) {
    return { ok: false, code: "STORAGE_UNAVAILABLE", error: "浏览器会话存储不可用，未执行 Agent 交接。" };
  }
  try {
    const key = agentWorkbenchHandoffStorageKey(target);
    const raw = targetStorage.getItem(key);
    // Delete before parse/validation so refresh, render errors, and malformed
    // bytes cannot replay a creative payload.
    targetStorage.removeItem(key);
    clearLegacyReceipt(targetStorage, target, raw);
    return parseAgentWorkbenchHandoff(raw, target, { nowMs });
  } catch {
    return { ok: false, code: "STORAGE_UNAVAILABLE", error: "浏览器会话存储读取失败，未执行 Agent 交接。" };
  }
}
