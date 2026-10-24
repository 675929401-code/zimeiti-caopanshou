import { officialStoryboardDirectorIdentity } from "./storyboard-director-identity";
import { STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION, STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION } from "./storyboard-director-protocol";
import { STORYBOARD_PERFORMANCE_CONTRACT_VERSION, storyboardPerformanceActivationTime } from "./storyboard-director-performance";

export const STORYBOARD_DIRECTOR_CONTRACT_FIELDS = [
  "production_contract_version", "production_contract_activated_at", "performance_contract", "performance_contract_activated_at",
] as const;

const contracts = [
  { version: "production_contract_version", time: "production_contract_activated_at", expected: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION },
  { version: "performance_contract", time: "performance_contract_activated_at", expected: STORYBOARD_PERFORMANCE_CONTRACT_VERSION },
] as const;
const markers = [STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION, STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION, STORYBOARD_PERFORMANCE_CONTRACT_VERSION];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class StoryboardDirectorContractActivationError extends Error {
  readonly code = "STORYBOARD_DIRECTOR_CONTRACT_INVALID";
}

/** Prompt authority comes from the editable server agent configuration, never chat content. */
export function canActivateStoryboardDirectorContracts(agentId: unknown, prompt: unknown): boolean {
  return Boolean(officialStoryboardDirectorIdentity(agentId)) && typeof prompt === "string"
    && markers.every(marker => prompt.includes(marker));
}

export function canRollbackStoryboardDirectorContracts(agentId: unknown, prompt: unknown): boolean {
  return Boolean(officialStoryboardDirectorIdentity(agentId)) && typeof prompt === "string" && Boolean(prompt.trim())
    && markers.every(marker => !prompt.includes(marker));
}

function validatePairs(style: Record<string, unknown>): void {
  for (const contract of contracts) {
    const hasVersion = Object.hasOwn(style, contract.version);
    const hasTime = Object.hasOwn(style, contract.time);
    if (!hasVersion && !hasTime) continue;
    if (!hasVersion || !hasTime || style[contract.version] !== contract.expected
      || storyboardPerformanceActivationTime(style[contract.time]) === undefined) {
      throw new StoryboardDirectorContractActivationError("制作合同的版本与激活时间须成对填写，且使用受支持的版本和有效 ISO 时间。");
    }
  }
}

export function hasActivatedStoryboardDirectorContract(value: unknown): boolean {
  const style = record(value);
  if (!style) return false;
  try { validatePairs(style); } catch { return false; }
  return contracts.some(contract => style[contract.version] === contract.expected);
}

function activationTimestamp(now: Date | string | number | undefined): string {
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? Date.now());
  if (!Number.isFinite(instant.getTime())) throw new StoryboardDirectorContractActivationError("合同保存时间无效。");
  return instant.toISOString();
}

/** Build a pending UI draft; the server replaces first-activation timestamps on save. */
export function createStoryboardDirectorContractDraft(input: { agentId: unknown; prompt: unknown; value: unknown; now?: Date | string | number }): Record<string, unknown> {
  if (!canActivateStoryboardDirectorContracts(input.agentId, input.prompt)) throw new StoryboardDirectorContractActivationError("当前智能体与提示词不支持此制作合同。");
  const style = record(input.value) || {};
  validatePairs(style);
  const next = { ...style };
  const now = activationTimestamp(input.now);
  for (const contract of contracts) {
    next[contract.version] = contract.expected;
    next[contract.time] = style[contract.time] ?? now;
  }
  return next;
}

/** Normalize only the four contract scalars; every unrelated style field retains its submitted value. */
export function normalizeStoryboardDirectorContractActivation(input: {
  agentId: unknown;
  prompt: unknown;
  /** The server must supply the prior persisted prompt, never a client claim. */
  previousPrompt?: unknown;
  previousValue: unknown;
  nextValue: unknown;
  now?: Date | string | number;
  action?: "activate" | "preserve" | "rollback";
}): unknown {
  const previous = record(input.previousValue) || {};
  const next = record(input.nextValue);
  if (input.action !== undefined && !["activate", "preserve", "rollback"].includes(input.action)) {
    throw new StoryboardDirectorContractActivationError("制作合同操作无效。");
  }
  if (input.action === "rollback") {
    if (!canRollbackStoryboardDirectorContracts(input.agentId, input.prompt) || !hasActivatedStoryboardDirectorContract(previous)
      || !next || STORYBOARD_DIRECTOR_CONTRACT_FIELDS.some(key => Object.hasOwn(next, key))) {
      throw new StoryboardDirectorContractActivationError("恢复旧版须同时提交不含新合同标记的旧提示词，并删除四项新合同字段；仅已启用合同的官方导演支持此操作。");
    }
    return input.nextValue;
  }
  const containsContract = STORYBOARD_DIRECTOR_CONTRACT_FIELDS.some(key => Object.hasOwn(previous, key) || Boolean(next && Object.hasOwn(next, key)));
  if (!containsContract) return input.nextValue;
  const changed = STORYBOARD_DIRECTOR_CONTRACT_FIELDS.some(key => Object.hasOwn(previous, key) !== Boolean(next && Object.hasOwn(next, key)) || previous[key] !== next?.[key]);
  if (!canActivateStoryboardDirectorContracts(input.agentId, input.prompt)) {
    const wasActivated = contracts.some(contract => previous[contract.version] === contract.expected
      && storyboardPerformanceActivationTime(previous[contract.time]) !== undefined);
    const wasModernPrompt = input.previousPrompt === undefined || canActivateStoryboardDirectorContracts(input.agentId, input.previousPrompt);
    if (officialStoryboardDirectorIdentity(input.agentId) && wasActivated && wasModernPrompt) {
      throw new StoryboardDirectorContractActivationError("已启用制作合同的提示词须保留完整合同标记；回退旧提示词需同时恢复其原合同配置。");
    }
    if (changed) throw new StoryboardDirectorContractActivationError("只有官方导演智能体的新合同提示词可以启用或修改制作合同。");
    return input.nextValue;
  }
  if (!next) throw new StoryboardDirectorContractActivationError("已启用的制作合同不能在本次编辑中删除。");
  validatePairs(next);
  const normalized = { ...next };
  let now: string | undefined;
  for (const contract of contracts) {
    if (!Object.hasOwn(next, contract.version)) {
      if (Object.hasOwn(previous, contract.version) || Object.hasOwn(previous, contract.time)) {
        throw new StoryboardDirectorContractActivationError("已启用的制作合同不能在本次编辑中删除。");
      }
      continue;
    }
    if (previous[contract.version] === contract.expected) {
      if (storyboardPerformanceActivationTime(previous[contract.time]) === undefined) {
        throw new StoryboardDirectorContractActivationError("已有制作合同缺少有效激活时间，请先核对原配置。");
      }
      normalized[contract.time] = previous[contract.time];
    } else {
      now ??= activationTimestamp(input.now);
      normalized[contract.time] = now;
    }
  }
  return normalized;
}
