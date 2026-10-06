import { normalizeAgentPresetFields, type AgentPresetField } from "@/lib/agent-preset-schema";

export const AGENT_ENGINEER_STATE_VERSION = "agent_engineer_state.v1" as const;
export const AGENT_PROMPT_PACKAGE_VERSION = "agent_prompt_package.v1" as const;
export const AGENT_ENGINEER_STATE_MARKER = "agent_engineer_state:v1" as const;

export interface RequirementLedgerItem {
  id: string;
  text: string;
  status?: "active" | "resolved" | "pending" | "conflict" | "superseded";
  supersedes?: string[];
}

export interface RequirementLedger {
  stable_requirements: RequirementLedgerItem[];
  current_changes: RequirementLedgerItem[];
  resolved: RequirementLedgerItem[];
  pending: RequirementLedgerItem[];
  conflicts: RequirementLedgerItem[];
  no_regression: RequirementLedgerItem[];
}

export interface AgentPromptPackage {
  schema_version: typeof AGENT_PROMPT_PACKAGE_VERSION;
  artifact_type: "agent_prompt_package";
  agent: {
    id: string;
    name: string;
    version: string;
  };
  change_summary: string[];
  system_prompt: string;
  preset_fields: AgentPresetField[];
  output_contract: unknown;
  regression_cases: unknown[];
  platform: Record<string, unknown>;
}

export interface AgentEngineerState {
  schema_version: typeof AGENT_ENGINEER_STATE_VERSION;
  mode: "delta" | "final";
  ledger: RequirementLedger;
  final_package?: AgentPromptPackage | null;
}

type UnknownRecord = Record<string, unknown>;

const LEDGER_KEYS = [
  "stable_requirements",
  "current_changes",
  "resolved",
  "pending",
  "conflicts",
  "no_regression",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItem(value: unknown, fallbackPrefix: string, index: number): RequirementLedgerItem | null {
  if (typeof value === "string" && value.trim()) {
    return { id: `${fallbackPrefix}-${index + 1}`, text: value.trim(), status: "active" };
  }
  if (!isRecord(value)) return null;
  const text = String(value.text ?? value.requirement ?? value.content ?? "").trim();
  if (!text) return null;
  const rawStatus = String(value.status ?? "active");
  const statuses = new Set(["active", "resolved", "pending", "conflict", "superseded"]);
  const item: RequirementLedgerItem = {
    id: String(value.id ?? `${fallbackPrefix}-${index + 1}`),
    text,
    status: statuses.has(rawStatus) ? rawStatus as RequirementLedgerItem["status"] : "active",
  };
  if (Array.isArray(value.supersedes)) item.supersedes = value.supersedes.map(String);
  return item;
}

function normalizeItems(value: unknown, prefix: string): RequirementLedgerItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const normalized = normalizeItem(item, prefix, index);
    return normalized ? [normalized] : [];
  });
}

export function emptyRequirementLedger(): RequirementLedger {
  return {
    stable_requirements: [],
    current_changes: [],
    resolved: [],
    pending: [],
    conflicts: [],
    no_regression: [],
  };
}

export function normalizeRequirementLedger(input: unknown): RequirementLedger {
  const source = isRecord(input) ? input : {};
  return {
    stable_requirements: normalizeItems(source.stable_requirements ?? source.stableRequirements ?? source["固定要求"], "req"),
    current_changes: normalizeItems(source.current_changes ?? source.currentChanges ?? source["本轮变更"], "chg"),
    resolved: normalizeItems(source.resolved ?? source["已解决"], "done"),
    pending: normalizeItems(source.pending ?? source["待确认"], "pending"),
    conflicts: normalizeItems(source.conflicts ?? source["冲突"], "conflict"),
    no_regression: normalizeItems(source.no_regression ?? source.noRegression ?? source["禁止回归"], "guard"),
  };
}

function mergeItems(base: RequirementLedgerItem[], updates: RequirementLedgerItem[]): RequirementLedgerItem[] {
  const merged = new Map(base.map((item) => [item.id, item]));
  for (const item of updates) {
    for (const supersededId of item.supersedes ?? []) {
      const previous = merged.get(supersededId);
      if (previous) merged.set(supersededId, { ...previous, status: "superseded" });
    }
    merged.set(item.id, { ...merged.get(item.id), ...item });
  }
  return [...merged.values()];
}

/** Merge a turn delta without deleting earlier requirements. */
export function applyRequirementLedgerUpdate(current: RequirementLedger, delta: Partial<RequirementLedger>): RequirementLedger {
  const next = emptyRequirementLedger();
  for (const key of LEDGER_KEYS) {
    next[key] = mergeItems(current[key], delta[key] ?? []);
  }
  return next;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function findJsonCandidate(text: string): unknown | null {
  const direct = parseJson(text);
  if (direct) return direct;

  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const fence of fences) {
    const parsed = parseJson(fence[1]);
    if (parsed) return parsed;
  }
  return null;
}

function normalizePackage(input: unknown): AgentPromptPackage | null {
  if (!isRecord(input)) return null;
  const source = isRecord(input.package) ? input.package : input;
  const systemPrompt = String(source.system_prompt ?? source.systemPrompt ?? "").trim();
  if (!systemPrompt) return null;
  const agentSource = isRecord(source.agent) ? source.agent : {};
  return {
    schema_version: AGENT_PROMPT_PACKAGE_VERSION,
    artifact_type: "agent_prompt_package",
    agent: {
      id: String(agentSource.id ?? source.agent_id ?? "new-agent"),
      name: String(agentSource.name ?? source.agent_name ?? "未命名智能体"),
      version: String(agentSource.version ?? source.version ?? "1.0.0"),
    },
    change_summary: Array.isArray(source.change_summary) ? source.change_summary.map(String) : [],
    system_prompt: systemPrompt,
    preset_fields: normalizeAgentPresetFields(source.preset_fields ?? source.presetFields ?? []),
    output_contract: source.output_contract ?? source.output_schema ?? {},
    regression_cases: Array.isArray(source.regression_cases) ? source.regression_cases : [],
    platform: isRecord(source.platform) ? source.platform : {},
  };
}

export function parseAgentEngineerState(text: string): AgentEngineerState | null {
  const markerPattern = new RegExp(`<!--\\s*${AGENT_ENGINEER_STATE_MARKER}\\s*([\\s\\S]*?)-->`, "i");
  const marker = text.match(markerPattern);
  const parsed = marker ? parseJson(marker[1]) : findJsonCandidate(text);
  if (!isRecord(parsed)) return null;

  const stateSource = isRecord(parsed.state) ? parsed.state : parsed;
  const packageSource = stateSource.final_package ?? stateSource.finalPackage ?? parsed.package;
  return {
    schema_version: AGENT_ENGINEER_STATE_VERSION,
    mode: stateSource.mode === "final" || packageSource ? "final" : "delta",
    ledger: normalizeRequirementLedger(stateSource.ledger ?? stateSource.requirement_ledger ?? {}),
    final_package: normalizePackage(packageSource),
  };
}

export function parseAgentPromptPackage(text: string): AgentPromptPackage | null {
  const parsed = findJsonCandidate(text);
  if (!isRecord(parsed)) return null;
  return normalizePackage(parsed.final_package ?? parsed.package ?? parsed);
}
