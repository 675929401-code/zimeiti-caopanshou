#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync("supabase/migrations/20260926094500_storyboard_image_protocol_contracts.sql", "utf8");
const rollback = fs.readFileSync("supabase/rollbacks/20260926094500_storyboard_image_protocol_contracts.rollback.sql", "utf8");
const route = fs.readFileSync("src/app/api/image/generate/route.ts", "utf8");

for (const id of [
  "pending-cover-model-1789087539302-c79bd2865ca4",
  "pending-cover-model-1789087566193-f4a5f4f1190f",
  "gemini-3-1-flash-image-chA",
  "gemini-3-0-pro-image-chA",
  "cover-model-seedream-5-pro",
]) assert.match(migration, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

assert.match(migration, /'gemini-3\.1-flash-image-4k'[\s\S]*'resolution_options',\s*jsonb_build_array\('4K'\)/u,
  "fixed 4K SKU must publish only 4K");
assert.match(migration, /'protocol',\s*'images_generations'/u);
assert.match(migration, /'protocol',\s*'chat_completions'/u);
assert.match(migration, /'protocol',\s*'volcengine_images_v3'/u);
assert.match(migration, /'reference_transport',\s*'chat_inline_data'/u);
assert.match(migration, /'result_delivery_hosts'[\s\S]*ark-acg-cn-beijing\.tos-cn-beijing\.volces\.com/u);
assert.match(route, /"ark-acg-cn-beijing\.tos-cn-beijing\.volces\.com"/u);
assert.doesNotMatch(route, /\*\.tos-cn-beijing\.volces\.com/u, "wildcard result hosts are forbidden");
assert.match(rollback, /- ARRAY\[/u);
assert.doesNotMatch(migration, /api_key|credential|secret/iu, "migration must not contain credentials");

console.log(JSON.stringify({
  passed: true,
  modelContracts: 5,
  existingGptContracts: 2,
  totalStoryboardModels: 7,
  fixedResolutionSku: "gemini-3.1-flash-image-4k=4K",
  providerCalls: 0,
  databaseWrites: 0,
}));
