#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000");
assert.ok(token && stepUp);
const response = await fetch(`${origin}/api/admin/agents?include_prompt=1&include_internal=1`, { headers: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp }, cache: "no-store" });
const body = await response.json();
assert.ok(response.ok, `HTTP_${response.status}`);
const rows = Array.isArray(body) ? body : body.agents;
const ids = new Set(["agent-1786633444187-594spj", "agent-1786843330392-emdjv2"]);
const selected = rows.filter((row) => ids.has(String(row?.id || "")));
assert.equal(selected.length, 2);
console.log(JSON.stringify({ passed: true, agents: selected.map((row) => ({ id: row.id, name: row.name, configRevision: row.config_revision, promptSha256: crypto.createHash("sha256").update(String(row.system_prompt || "")).digest("hex"), promptLength: String(row.system_prompt || "").length, outputStyle: row.output_style, responseFormat: row.response_format, maxReplyTokens: row.max_reply_tokens })) }, null, 2));
