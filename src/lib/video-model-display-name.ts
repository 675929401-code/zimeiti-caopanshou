/** Correct the evidenced legacy label only while its live binding still matches. */
export function correctVideoModelBindingDisplayName(value: unknown, binding: Record<string, unknown>): string {
  const name = String(value || "").trim();
  if (String(binding.id || "").trim() !== "veo-3-1-fast-chC"
    || String(binding.protocol_type || "").trim() !== "gaorui_video"
    || String(binding.model_name || "").trim() !== "veo_3_1-fl") return name;

  // This stored row uses the same upstream model as the non-Fast entry. Do not
  // infer a different engine or change any of its stated input capabilities.
  return name.replace(/^Veo\s+3\.1\s+Fast(?=\s*(?:[·|｜/（(]|$))/iu, "Veo 3.1");
}

/** Remove operational review notes from a video model's public name only. */
export function stripVideoModelOperationalAnnotation(value: unknown): string {
  let name = String(value || "").trim();
  const operationalSuffix = /\s*(?:[·|｜/]\s*)?[（(]?\s*(?:能力核对中|能力待核验|配置待验收|待验收|待开放)\s*[）)]?\s*$/u;
  let cleaned = name.replace(operationalSuffix, "").trim();
  while (cleaned !== name) {
    name = cleaned;
    cleaned = name.replace(operationalSuffix, "").trim();
  }
  return name;
}
