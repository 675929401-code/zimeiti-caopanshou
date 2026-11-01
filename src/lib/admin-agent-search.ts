import { BIP_CATEGORY, BIP_CATEGORY_LABEL, displayCategory, TASK_CATEGORIES, taskCategory } from "./business-ip/catalog";

export interface SearchableAdminAgent {
  id: string;
  name: string;
  description?: string | null;
  category?: string;
  source?: string;
  model?: string | null;
  model_id?: string | null;
  configuration_access?: "visible" | "protected";
}

export interface AdminAgentSearchModel {
  id: string;
  name?: string;
  model_name?: string;
}

export function normalizeAdminAgentSearchQuery(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/** Search only list metadata already visible to this administrator. */
export function filterAdminAgents<T extends SearchableAdminAgent>(
  agents: readonly T[],
  query: string,
  models: readonly AdminAgentSearchModel[] = [],
): T[] {
  const terms = normalizeAdminAgentSearchQuery(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return [...agents];

  const modelById = new Map(models.map((model) => [model.id, model]));
  return agents.filter((agent) => {
    const categoryKey = displayCategory(agent);
    const categoryLabel = categoryKey === BIP_CATEGORY
      ? BIP_CATEGORY_LABEL
      : TASK_CATEGORIES.find((category) => category.key === categoryKey)?.label;
    const values: Array<string | null | undefined> = [
      agent.id, agent.name, agent.description, agent.category, agent.source,
      taskCategory(agent), categoryKey, categoryLabel,
    ];
    // A locked view must not reveal protected model metadata through matches.
    if (agent.configuration_access === "visible") {
      const model = agent.model_id ? modelById.get(agent.model_id) : undefined;
      values.push(agent.model, agent.model_id, model?.name, model?.model_name);
    }
    const haystack = normalizeAdminAgentSearchQuery(values.filter((value): value is string => typeof value === "string").join(" "));
    return terms.every((term) => haystack.includes(term));
  });
}
