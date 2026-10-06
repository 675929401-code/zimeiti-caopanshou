export type CoverModelRetirementTarget = {
  id?: string | null;
  name?: string | null;
  model_name?: string | null;
  provider?: string | null;
};

const RETIRED_TEXT_PATTERNS = [
  /豆包/i,
  /doubao/i,
  /seedream/i,
  /seededit/i,
];

const RETIRED_PROVIDER_PATTERNS = [
  /^volcengine$/i,
];

function modelSearchText(model: CoverModelRetirementTarget): string {
  return [
    model.id,
    model.name,
    model.model_name,
    model.provider,
  ].filter(Boolean).join(" ");
}

export function isRetiredCoverModel(model: CoverModelRetirementTarget | null | undefined): boolean {
  if (!model) return false;
  if (model.provider && RETIRED_PROVIDER_PATTERNS.some((pattern) => pattern.test(model.provider || ""))) return true;
  const text = modelSearchText(model);
  return RETIRED_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

export function filterAvailableCoverModels<T extends CoverModelRetirementTarget>(models: T[] | null | undefined): T[] {
  return (models || []).filter((model) => !isRetiredCoverModel(model));
}
