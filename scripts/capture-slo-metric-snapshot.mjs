import { createHmac, randomUUID } from "node:crypto";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.join("=") || true];
}));
const execute = args.has("--execute");
const baseUrl = String(args.get("--base-url") || process.env.SLO_METRIC_CAPTURE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const rawHours = Number(args.get("--hours") || 24);
const windowHours = Number.isFinite(rawHours) ? Math.min(24 * 7, Math.max(1, Math.round(rawHours))) : 24;
const requestKey = String(args.get("--request-key") || `slo-metric:${new Date().toISOString().slice(0, 13)}:${randomUUID()}`);
const body = JSON.stringify({ windowHours });

if (!execute) {
  console.log(JSON.stringify({
    mode: "plan",
    endpoint: `${baseUrl}/api/internal/slo-metrics/capture`,
    windowHours,
    requestKey,
    networkRequests: 0,
    databaseWrites: 0,
    requirement: "Pass --execute only from an independent scheduler with SLO_METRIC_CAPTURE_ENABLED=1 and SLO_METRIC_CAPTURE_SECRET configured on both sides.",
  }, null, 2));
  process.exit(0);
}

const secret = String(process.env.SLO_METRIC_CAPTURE_SECRET || "");
if (secret.length < 32) throw new Error("SLO_METRIC_CAPTURE_SECRET must contain at least 32 characters");
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/u.test(requestKey)) throw new Error("--request-key is invalid");

const timestamp = String(Math.floor(Date.now() / 1_000));
const signature = createHmac("sha256", secret)
  .update(`${timestamp}\n${requestKey}\n${body}`)
  .digest("hex");
const response = await fetch(`${baseUrl}/api/internal/slo-metrics/capture`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": requestKey,
    "x-slo-capture-timestamp": timestamp,
    "x-slo-capture-signature": `sha256=${signature}`,
  },
  body,
});
const responseBody = await response.text();
let payload;
try {
  payload = JSON.parse(responseBody);
} catch {
  payload = { raw: responseBody.slice(0, 500) };
}
console.log(JSON.stringify({
  mode: "execute",
  status: response.status,
  ok: response.ok,
  requestKey,
  payload,
}, null, 2));
if (!response.ok) process.exitCode = 1;
