const OFFICIAL_COZE_ROOT_DOMAINS = ["coze.site", "coze.cn"];

/**
 * @param {unknown} value
 * @returns {URL | null}
 */
export function parseOfficialCozeCodingEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  let endpoint;
  try {
    endpoint = new URL(value.trim());
  } catch {
    return null;
  }

  if (endpoint.protocol !== "https:") return null;
  if (endpoint.username || endpoint.password) return null;
  // URL normalizes an explicit default :443 to an empty port. Any remaining
  // port is non-default and is not an official Coze Coding endpoint.
  if (endpoint.port) return null;

  const hostname = endpoint.hostname.toLowerCase();
  const officialHost = OFFICIAL_COZE_ROOT_DOMAINS.some(
    (rootDomain) => hostname === rootDomain || hostname.endsWith(`.${rootDomain}`),
  );
  return officialHost ? endpoint : null;
}
