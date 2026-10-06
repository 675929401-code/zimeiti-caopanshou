const ENABLED_IMAGE_PARSING_VALUES = new Set([
  "1",
  "true",
  "reverse",
  "gpt_vision",
  "global",
]);

/**
 * Interpret the persisted image_parsing enum without JavaScript truthiness.
 * Unknown values fail closed so a typo can never authorize a paid image call.
 */
export function isImageParsingEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ENABLED_IMAGE_PARSING_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/**
 * Detect only OpenAI-compatible multimodal message parts. Plain text that
 * happens to contain the words image_url is deliberately not treated as media.
 */
export function hasImageInput(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  return value.some((message) => {
    if (!message || typeof message !== "object") return false;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;

    return content.some((part) => (
      Boolean(part)
      && typeof part === "object"
      && (part as { type?: unknown }).type === "image_url"
    ));
  });
}
