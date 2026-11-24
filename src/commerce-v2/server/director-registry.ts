import "server-only";

import { directorCatalog } from "../../commerce/server/director-catalog";
import { operations } from "../../commerce/server/operation-routing";
import { primePublishedCommerceConfiguration } from "../../commerce/server/configuration-platform";
import { resolveOperationPrompt } from "../../commerce/server/prompts";
import { commerceV2Sha256 } from "./hash";

export async function commerceV2DirectorRegistry() {
  const published = await primePublishedCommerceConfiguration();
  const cards = directorCatalog();
  const routes = new Map(operations().map(route => [route.id, route]));
  const seen = new Set<string>();
  const identities = cards.map(card => {
    if (seen.has(card.key)) throw new Error(`编导标识重复：${card.key}`);
    seen.add(card.key);
    const route = routes.get(`director.${card.key}`);
    const binding = published?.cards.find(item => item.stableKey === card.key);
    try {
      if (!route || route.kind !== "agent") throw new Error("对话模型路由未配置");
      const {prompt, publishedPrompt} = resolveOperationPrompt(route.promptId, binding?.promptVersionId, published);
      if ((!binding?.promptVersionId && prompt.id !== route.promptId) || !prompt.content.trim()) throw new Error("提示词版本未配置");
      const promptVersion = commerceV2Sha256({ key: prompt.id, id: publishedPrompt?.id, version: prompt.version, content: prompt.content });
      return {card, prompt:prompt.content, promptVersion, routeVersion:route.revision, configurationIssue:""};
    } catch {
      return {card, prompt:"", promptVersion:"", routeVersion:route?.revision, configurationIssue:"请在后台核对编导的模型路由和提示词版本"};
    }
  });
  const registryVersion = commerceV2Sha256(identities.map(({card,promptVersion,routeVersion}) =>
    ({key:card.key, catalogVersion:card.catalogVersion, promptVersion, routeVersion})
  ));
  return identities.map(({card,prompt,promptVersion,configurationIssue}) => ({
    key: card.key,
    name: card.default ? "通用编导" : card.name,
    description: card.description,
    category: card.default ? "通用" : card.category,
    recommended: card.recommended,
    isDefault: card.default === true,
    icon: card.icon,
    slots: card.slots.map(slot => ({key:slot.key,label:slot.label,min:slot.min,max:slot.max,kinds:[...slot.kinds]})),
    registryVersion,
    promptVersion,
    prompt,
    configurationIssue,
    outputProtocol: "director-script/v2" as const,
  }));
}

export type CommerceV2DirectorDefinition = Awaited<ReturnType<typeof commerceV2DirectorRegistry>>[number];

export async function publicCommerceV2DirectorCatalog() {
  return (await commerceV2DirectorRegistry()).map(({prompt: _privatePrompt, ...director}) => director);
}

export async function commerceV2DirectorPrompt(skillKey: string, promptVersion: string) {
  const director = (await commerceV2DirectorRegistry()).find(item => item.key === skillKey);
  if (!director) throw new Error("编导不存在");
  if (director.configurationIssue) throw new Error(director.configurationIssue);
  if (director.promptVersion !== promptVersion) throw new Error("编导提示词版本已经变化，请重新应用");
  return director.prompt;
}

export async function commerceV2DirectorDefinition(skillKey: string, registryVersion: string, promptVersion: string) {
  const director = (await commerceV2DirectorRegistry()).find(item => item.key === skillKey);
  if (!director) throw new Error("编导不存在");
  if (director.configurationIssue) throw new Error(director.configurationIssue);
  if (director.registryVersion !== registryVersion) throw new Error("编导目录版本已经变化，请重新选择");
  if (director.promptVersion !== promptVersion) throw new Error("编导提示词版本已经变化，请重新应用");
  return director;
}
