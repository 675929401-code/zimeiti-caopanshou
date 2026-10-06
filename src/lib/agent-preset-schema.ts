export const AGENT_PRESET_SCHEMA_VERSION = "agent_preset_fields.v1" as const;

export type AgentPresetFieldType = "text" | "select" | "textarea";

export interface AgentPresetField {
  id: string;
  label: string;
  type: AgentPresetFieldType;
  placeholder: string;
  required: boolean;
  options: string[];
  order: number;
  contentPrefix?: string;
  sendLabel?: boolean;
  sendText?: string;
  description?: string;
  defaultValue?: string;
}

export interface AgentPresetEnvelope {
  schema_version: typeof AGENT_PRESET_SCHEMA_VERSION;
  fields: AgentPresetField[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{1,95}$/.test(trimmed) ? trimmed : null;
}

function deriveStableId(label: string, occurrence: number): string {
  const normalized = label.trim().toLocaleLowerCase() || "field";
  const suffix = occurrence > 1 ? `_${occurrence}` : "";
  return `field_${stableHash(normalized)}${suffix}`;
}

function unwrapFields(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return [];
  if (Array.isArray(input.fields)) return input.fields;
  if (Array.isArray(input.preset_fields)) return input.preset_fields;
  if (Array.isArray(input.presetFields)) return input.presetFields;
  return [];
}

function normalizeType(value: unknown): AgentPresetFieldType {
  if (value === "select") return "select";
  if (value === "textarea") return "textarea";
  return "text";
}

/**
 * Accepts legacy arrays and versioned envelopes. Existing IDs always win;
 * missing legacy IDs receive a deterministic ID so order or label copy changes
 * no longer regenerate every field on each admin edit.
 */
export function normalizeAgentPresetFields(input: unknown): AgentPresetField[] {
  const source = unwrapFields(input);
  const occurrences = new Map<string, number>();
  const usedIds = new Set<string>();

  return source.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];

    const label = String(raw.label ?? raw.title ?? "").trim();
    if (!label) return [];

    const occurrence = (occurrences.get(label) ?? 0) + 1;
    occurrences.set(label, occurrence);

    let id = sanitizeId(raw.id) ?? deriveStableId(label, occurrence);
    if (usedIds.has(id)) {
      let duplicate = 2;
      while (usedIds.has(`${id}_${duplicate}`)) duplicate += 1;
      id = `${id}_${duplicate}`;
    }
    usedIds.add(id);

    const type = normalizeType(raw.type);
    const rawOrder = Number(raw.order);
    const order = Number.isFinite(rawOrder) ? Math.max(0, Math.trunc(rawOrder)) : index;
    const options = type === "select" && Array.isArray(raw.options)
      ? raw.options.map(String).map((item) => item.trim()).filter(Boolean)
      : [];

    const field: AgentPresetField = {
      id,
      label,
      type,
      placeholder: String(raw.placeholder ?? ""),
      required: raw.required === true,
      options,
      order,
    };

    if (typeof raw.contentPrefix === "string") field.contentPrefix = raw.contentPrefix;
    if (raw.sendLabel !== undefined) field.sendLabel = raw.sendLabel !== false;
    if (typeof raw.sendText === "string") field.sendText = raw.sendText;
    if (typeof raw.description === "string") field.description = raw.description;
    if (typeof raw.defaultValue === "string") field.defaultValue = raw.defaultValue;
    else if (typeof raw.default_value === "string") field.defaultValue = raw.default_value;

    return [field];
  });
}

export function toAgentPresetEnvelope(input: unknown): AgentPresetEnvelope {
  return {
    schema_version: AGENT_PRESET_SCHEMA_VERSION,
    fields: normalizeAgentPresetFields(input),
  };
}

export function createAgentPresetFieldId(prefix = "field"): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "_") || "field";
  const randomId = globalThis.crypto?.randomUUID?.().replace(/-/g, "");
  if (randomId) return `${safePrefix}_${randomId}`;
  return `${safePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
