/** Editor single-value media slots serialize unused controls as empty strings.
 * Treat only undefined and blank strings as absent; retain every other value
 * for the provider validator. Array entries must never use this omission rule.
 */
export function isVideoOptionalMediaInputAbsent(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length === 0);
}
