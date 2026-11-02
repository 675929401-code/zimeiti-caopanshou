import type { ChatModelGroup } from "./chat-model-catalog";

/** Menu presentation only. The complete catalog still owns persisted choices,
 * current-model labels and submission IDs, including existing older selections.
 */
export function chatModelSwitcherDisplayGroups(groups: readonly ChatModelGroup[]): ChatModelGroup[] {
  return groups.filter(group => group.brand === "deepseek")
    .map(group => ({ ...group, models: group.models.filter(model => /^DeepSeek[\s_-]+v?4[._-]1[\s_-]+Flash(?:\s*[（(][^（）()]*[）)])*$/iu.test(model.label)) }))
    .filter(group => group.models.length > 0);
}
