#!/usr/bin/env node
import assert from "node:assert/strict";
const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000");
assert.ok(token);
const response = await fetch(`${origin}/api/cover-models?surface=storyboard-workbench`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
const body = await response.json();
assert.ok(response.ok, `HTTP_${response.status}`);
console.log(JSON.stringify({ passed: true, models: (body.models || []).map((model) => ({ id: model.id, name: model.name, displayName: model.displayName, available: model.capabilities?.available, priceReady: model.capabilities?.priceReady, resolutionOptions: model.capabilities?.resolutionOptions, aspectRatios: model.capabilities?.aspectRatios, supportsReferenceInput: model.capabilities?.supportsReferenceInput, maxReferenceImages: model.capabilities?.maxReferenceImages })) }, null, 2));
