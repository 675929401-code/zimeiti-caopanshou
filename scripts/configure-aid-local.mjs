import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const secureDir = join(root, ".secure");
const secretPath = join(secureDir, "aid-integration.secret");
const envPath = join(root, ".env.local");

mkdirSync(secureDir, { recursive: true });
const secret = existsSync(secretPath)
  ? readFileSync(secretPath, "utf8").trim()
  : randomBytes(48).toString("base64url");
if (secret.length < 32) throw new Error("Existing AID bridge secret is too short");
if (!existsSync(secretPath)) writeFileSync(secretPath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });

const values = {
  AID_INTEGRATION_ENABLED: "true",
  AID_STUDIO_URL: "http://127.0.0.1:4332",
  AID_BRIDGE_HMAC_SECRET: secret,
};
const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const lines = original.split(/\r?\n/);
const seen = new Set();
const updated = lines.map((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (!match || !(match[1] in values)) return line;
  seen.add(match[1]);
  return `${match[1]}=${values[match[1]]}`;
});
for (const [key, value] of Object.entries(values)) {
  if (!seen.has(key)) updated.push(`${key}=${value}`);
}
writeFileSync(envPath, `${updated.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
process.stdout.write("AID local integration configuration is present; secret value was not printed.\n");
