const VERSION_SEGMENT_RE = /^\/v\d+(?:\/|$)/;

const TERMINAL_PATHS = [
  "/chat/completions",
  "/images/generations",
  "/images/edits",
  "/video/create",
  "/video/query",
  "/video/generations",
  "/videos",
  "/kling/v1/videos/text2video",
  "/kling/v1/videos/image2video",
];

function normalizeRawEndpoint(endpoint: string): string {
  return (endpoint || "").trim().replace(/\/+$/, "");
}

function stripTerminalPath(pathname: string): string {
  let path = pathname.replace(/\/+$/, "") || "/";

  for (const terminal of TERMINAL_PATHS) {
    const index = path.toLowerCase().indexOf(terminal.toLowerCase());
    if (index >= 0) {
      path = path.slice(0, index) || "/";
      break;
    }
  }

  return path.replace(/\/+$/, "") || "/";
}

function joinUrlPath(origin: string, path: string): string {
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

export function normalizeOpenAIBase(endpoint: string, defaultVersion = "v1"): string {
  const raw = normalizeRawEndpoint(endpoint);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const strippedPath = stripTerminalPath(url.pathname);

    if (VERSION_SEGMENT_RE.test(strippedPath)) {
      return `${url.origin}${strippedPath}`;
    }

    if (/\/api\/(?:paas\/)?v\d+$/i.test(strippedPath)) {
      return `${url.origin}${strippedPath}`;
    }

    return `${url.origin}${strippedPath === "/" ? "" : strippedPath}/${defaultVersion}`;
  } catch {
    const stripped = raw.replace(/\/+$/, "");
    return /\/v\d+$/i.test(stripped) ? stripped : `${stripped}/${defaultVersion}`;
  }
}

export function buildOpenAIEndpoint(endpoint: string, resourcePath: string): string {
  const base = normalizeOpenAIBase(endpoint);
  if (!base) return "";
  return `${base.replace(/\/+$/, "")}/${resourcePath.replace(/^\/+/, "")}`;
}

export function normalizeApiRoot(endpoint: string): string {
  const raw = normalizeRawEndpoint(endpoint);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    let path = stripTerminalPath(url.pathname);
    path = path.replace(/\/v\d+$/i, "");
    return `${url.origin}${path === "/" ? "" : path}`;
  } catch {
    return raw
      .replace(/\/chat\/completions$/i, "")
      .replace(/\/images\/generations$/i, "")
      .replace(/\/images\/edits$/i, "")
      .replace(/\/video\/create$/i, "")
      .replace(/\/video\/query$/i, "")
      .replace(/\/videos(?:\/.*)?$/i, "")
      .replace(/\/v\d+$/i, "")
      .replace(/\/+$/, "");
  }
}

export function buildApiRootEndpoint(endpoint: string, path: string): string {
  const root = normalizeApiRoot(endpoint);
  if (!root) return "";
  return joinUrlPath(root, path);
}

export function buildPathEndpoint(endpoint: string, path: string): string {
  const raw = normalizeRawEndpoint(endpoint);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const basePath = stripTerminalPath(url.pathname);
    if (basePath !== "/" && normalizedPath.startsWith(`${basePath}/`)) {
      return joinUrlPath(url.origin, normalizedPath);
    }
    return joinUrlPath(`${url.origin}${basePath === "/" ? "" : basePath}`, normalizedPath);
  } catch {
    return `${raw}${normalizedPath}`;
  }
}
