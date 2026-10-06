// Protected server runtime environment loader.
//
// Production secrets stay outside Git. This helper only loads an existing
// server-private env file into process.env, using dotenv instead of shell
// `source` so keys containing spaces, #, <, > or other characters are parsed
// safely and are never executed by the shell.

const fs = require("fs");
const path = require("path");

let envLoadAttempted = false;

function compactUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function ensureServerRuntimeEnvLoaded(): void {
  if (envLoadAttempted) return;
  envLoadAttempted = true;

  try {
    const dotenv = require("dotenv");
    const cwd = process.cwd();
    const explicitEnvFile = process.env.PROTECTED_ENV_FILE || process.env.SERVER_ENV_FILE;
    const releaseRoot = process.env.RELEASE_ROOT;
    const candidates = compactUnique([
      explicitEnvFile || "",
      releaseRoot ? path.join(releaseRoot, ".env.local") : "",
      path.join(cwd, ".env.local"),
      path.join(cwd, "..", ".env.local"),
      path.join(cwd, "..", "..", ".env.local"),
    ]);

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      dotenv.config({ path: candidate, quiet: true, override: false });
      if (
        process.env.JWT_SECRET &&
        process.env.COZE_SUPABASE_URL &&
        (process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY)
      ) {
        break;
      }
    }
  } catch {
    // Keep fail-closed behavior at call sites: they will still reject missing
    // required secrets instead of silently pretending configuration exists.
  }
}
