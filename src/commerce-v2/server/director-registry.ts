import "server-only";

import { baselineDirectorCatalog } from "../../commerce/server/director-catalog";
import { directorTemplates } from "../../commerce/server/director-prompts";
import { commerceV2Sha256 } from "./hash";

const SHARED_DIRECTOR_AUTHORITY = "带货 Agent v2 共享商业导演核心。事实优先，素材职责明确，输出必须可执行、可局部修订并能应用到生产计划。";

export type CommerceV2DirectorDefinition = {
  key: string;
  name: string;
  description: string;
  category: string;
  recommended: boolean;
  isDefault: boolean;
  icon: string;
  slots: Array<{
    key: string;
    label: string;
    min: number;
    max: number;
    kinds: string[];
  }>;
  registryVersion: string;
  promptVersion: string;
  prompt: string;
  outputProtocol: "director-script/v2";
};

let cached: CommerceV2DirectorDefinition[] | null = null;

export function commerceV2DirectorRegistry() {
  if (cached) return cached.map((item) => ({ ...item, slots: item.slots.map((slot) => ({ ...slot, kinds: [...slot.kinds] })) }));
  const cards = baselineDirectorCatalog();
  const templates = new Map(directorTemplates(SHARED_DIRECTOR_AUTHORITY).map((template) => [template.id.replace(/^director\./u, ""), template]));
  const identities = cards.map((card) => {
    const template = templates.get(card.key);
    if (!template) throw new Error(`编导 ${card.key} 缺少提示词版本`);
    const promptVersion = commerceV2Sha256({ key: card.key, version: template.version, content: template.content });
    return {
      card,
      template,
      promptVersion,
    };
  });
  if (identities.length !== 19 || new Set(identities.map((item) => item.card.key)).size !== 19) throw new Error("带货 Agent v2 必须固定装载 19 个唯一编导");
  const registryVersion = commerceV2Sha256(identities.map(({ card, promptVersion }) => ({ key: card.key, catalogVersion: card.catalogVersion, promptVersion })));
  cached = identities.map(({ card, template, promptVersion }) => ({
    key: card.key,
    name: card.default ? "通用编导" : card.name,
    description: card.description,
    category: card.default ? "通用" : card.category,
    recommended: card.recommended,
    isDefault: card.default === true,
    icon: card.icon,
    slots: card.slots.map((slot) => ({ key: slot.key, label: slot.label, min: slot.min, max: slot.max, kinds: [...slot.kinds] })),
    registryVersion,
    promptVersion,
    prompt: template.content,
    outputProtocol: "director-script/v2",
  }));
  return commerceV2DirectorRegistry();
}

export function publicCommerceV2DirectorCatalog() {
  return commerceV2DirectorRegistry().map(({ prompt, ...director }) => {
    if (!prompt.trim()) throw new Error(`编导 ${director.key} 的提示词为空`);
    return director;
  });
}

export function commerceV2DirectorPrompt(skillKey: string, promptVersion: string) {
  const director = commerceV2DirectorRegistry().find((item) => item.key === skillKey);
  if (!director) throw new Error("编导不存在");
  if (director.promptVersion !== promptVersion) throw new Error("编导提示词版本已经变化，请重新应用");
  return director.prompt;
}

export function commerceV2DirectorDefinition(skillKey: string, registryVersion: string, promptVersion: string) {
  const director = commerceV2DirectorRegistry().find((item) => item.key === skillKey);
  if (!director) throw new Error("编导不存在");
  if (director.registryVersion !== registryVersion) throw new Error("编导目录版本已经变化，请重新选择");
  if (director.promptVersion !== promptVersion) throw new Error("编导提示词版本已经变化，请重新应用");
  return director;
}
