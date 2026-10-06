import "server-only";

import {
  validateSkillPackagePayload,
  type ResolvedSkillPackage,
  type SkillActor,
  type SkillJsonObject,
} from "@/lib/server/skill-package-contract";

export interface SkillSelectionRejection {
  slug: string;
  reason: "NOT_FOUND" | "NOT_AVAILABLE" | "DISABLED" | "NEGATIVE_SIGNAL" | "AUTO_LIMIT";
}

export interface SelectedSkill {
  slug: string;
  packageId: string;
  versionId: string;
  commandName: string;
  score: number;
  reason: "explicit" | "auto";
  priority: number;
}

export interface SkillSelectionResult {
  selected: SelectedSkill[];
  rejected: SkillSelectionRejection[];
  explicitRequested: string[];
  autoEvaluated: boolean;
}

export interface ResolveSkillSelectionInput {
  skills: ResolvedSkillPackage[];
  message: string;
  explicitSlugs?: string[];
  maxAutoSkills?: number;
}

export interface SkillExecutionContext {
  packageId: string;
  versionId: string;
  slug: string;
  commandName: string;
  instructions: string;
  inputSchema: SkillJsonObject;
  outputSchema: SkillJsonObject;
  executionType: "prompt" | "tool" | "workflow" | "hybrid";
  routing: {
    reason: "explicit" | "auto";
    score: number;
    priority: number;
  };
  orchestration: ReturnType<typeof validateSkillPackagePayload>["orchestration"];
  tools: ReturnType<typeof validateSkillPackagePayload>["tools"];
  sanitizedConfig: SkillJsonObject;
}

function normalizeTerm(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function uniqueTerms(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeTerm).filter(Boolean)));
}

function metadataBoolean(metadata: SkillJsonObject, key: string): boolean {
  return metadata[key] === true;
}

export function isSkillAvailableForActor(skill: ResolvedSkillPackage, actor?: SkillActor | null): boolean {
  const packageRow = skill.package;
  if (
    packageRow.lifecycle !== "published" ||
    !packageRow.active_version_id ||
    packageRow.active_version_id !== skill.version.id ||
    skill.version.status !== "released" ||
    !skill.version.published_at
  ) {
    return false;
  }

  if (packageRow.visibility === "private" && packageRow.created_by !== actor?.userId) return false;
  if (packageRow.visibility === "tenant" && !actor) return false;
  if (skill.installation) return skill.installation.enabled;
  return packageRow.visibility === "public" && metadataBoolean(packageRow.metadata, "implicit_install");
}

function explicitIdentifiers(message: string, explicitSlugs: string[]): string[] {
  const fromMessage = Array.from(message.matchAll(/(?:^|\s)\/([a-z0-9]+(?:[._-][a-z0-9]+)*)\b/gi)).map(
    (match) => normalizeTerm(match[1] ?? ""),
  );
  return uniqueTerms([...explicitSlugs, ...fromMessage]);
}

function autoScore(skill: ResolvedSkillPackage, normalizedMessage: string): number {
  const payload = validateSkillPackagePayload(skill.version.payload);
  const negativeSignals = uniqueTerms([
    ...payload.manifest.negativeTriggerSignals,
    ...payload.routing.negativeTriggerSignals,
  ]);
  if (negativeSignals.some((signal) => normalizedMessage.includes(signal))) return Number.NEGATIVE_INFINITY;

  const signals = uniqueTerms([
    ...payload.manifest.triggerSignals,
    ...payload.routing.triggerSignals,
    ...payload.manifest.tags,
    payload.manifest.category,
  ]);
  const matched = signals.filter((signal) => normalizedMessage.includes(signal));
  if (matched.length === 0) return 0;
  const longest = Math.max(...matched.map((signal) => signal.length));
  return matched.length * 100 + longest + payload.manifest.priority + payload.routing.priority;
}

export function resolveSkillSelection(input: ResolveSkillSelectionInput): SkillSelectionResult {
  const normalizedMessage = normalizeTerm(input.message);
  const explicitRequested = explicitIdentifiers(input.message, input.explicitSlugs ?? []);
  const maxAutoSkills = Math.max(0, Math.min(input.maxAutoSkills ?? 3, 8));
  const byIdentifier = new Map<string, ResolvedSkillPackage>();

  for (const skill of input.skills) {
    const payload = validateSkillPackagePayload(skill.version.payload);
    byIdentifier.set(normalizeTerm(skill.package.slug), skill);
    byIdentifier.set(normalizeTerm(payload.manifest.commandName.replace(/^\//, "")), skill);
  }

  const selected = new Map<string, SelectedSkill>();
  const rejected: SkillSelectionRejection[] = [];

  for (const identifier of explicitRequested) {
    const skill = byIdentifier.get(identifier);
    if (!skill) {
      rejected.push({ slug: identifier, reason: "NOT_FOUND" });
      continue;
    }
    if (!skill.installation && !metadataBoolean(skill.package.metadata, "implicit_install")) {
      rejected.push({ slug: skill.package.slug, reason: "NOT_AVAILABLE" });
      continue;
    }
    if (skill.installation && !skill.installation.enabled) {
      rejected.push({ slug: skill.package.slug, reason: "DISABLED" });
      continue;
    }
    const payload = validateSkillPackagePayload(skill.version.payload);
    selected.set(skill.package.id, {
      slug: skill.package.slug,
      packageId: skill.package.id,
      versionId: skill.version.id,
      commandName: payload.manifest.commandName,
      score: Number.MAX_SAFE_INTEGER,
      reason: "explicit",
      priority: skill.installation?.priority ?? payload.routing.priority ?? payload.manifest.priority,
    });
  }

  const autoCandidates = input.skills
    .filter((skill) => !selected.has(skill.package.id))
    .map((skill) => {
      const payload = validateSkillPackagePayload(skill.version.payload);
      const autoEnabled =
        Boolean(skill.installation?.enabled) &&
        (payload.routing.autoInvoke || payload.manifest.autoInvoke);
      const score = autoEnabled ? autoScore(skill, normalizedMessage) : 0;
      return { skill, payload, autoEnabled, score };
    })
    .filter((candidate) => candidate.autoEnabled && candidate.score !== 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const leftPriority = left.skill.installation?.priority ?? left.payload.routing.priority;
      const rightPriority = right.skill.installation?.priority ?? right.payload.routing.priority;
      return rightPriority - leftPriority;
    });

  let acceptedAuto = 0;
  for (const candidate of autoCandidates) {
    if (candidate.score === Number.NEGATIVE_INFINITY) {
      rejected.push({ slug: candidate.skill.package.slug, reason: "NEGATIVE_SIGNAL" });
      continue;
    }
    if (acceptedAuto >= maxAutoSkills) {
      rejected.push({ slug: candidate.skill.package.slug, reason: "AUTO_LIMIT" });
      continue;
    }
    selected.set(candidate.skill.package.id, {
      slug: candidate.skill.package.slug,
      packageId: candidate.skill.package.id,
      versionId: candidate.skill.version.id,
      commandName: candidate.payload.manifest.commandName,
      score: candidate.score,
      reason: "auto",
      priority: candidate.skill.installation?.priority ?? candidate.payload.routing.priority,
    });
    acceptedAuto += 1;
  }

  return {
    selected: Array.from(selected.values()),
    rejected,
    explicitRequested,
    autoEvaluated: maxAutoSkills > 0,
  };
}

export function buildSkillExecutionContexts(
  skills: ResolvedSkillPackage[],
  selection: SkillSelectionResult,
): SkillExecutionContext[] {
  const byId = new Map(skills.map((skill) => [skill.package.id, skill]));
  return selection.selected.map((selected) => {
    const skill = byId.get(selected.packageId);
    if (!skill || skill.version.id !== selected.versionId) {
      throw new Error("SKILL_SELECTION_STALE");
    }
    const payload = validateSkillPackagePayload(skill.version.payload);
    return {
      packageId: skill.package.id,
      versionId: skill.version.id,
      slug: skill.package.slug,
      commandName: payload.manifest.commandName,
      instructions: payload.instructions,
      inputSchema: payload.input_schema as SkillJsonObject,
      outputSchema: payload.output_schema as SkillJsonObject,
      executionType: payload.execution_type,
      routing: {
        reason: selected.reason,
        score: selected.score,
        priority: selected.priority,
      },
      orchestration: payload.orchestration,
      tools: payload.tools,
      sanitizedConfig: payload.sanitized_config as SkillJsonObject,
    };
  });
}
