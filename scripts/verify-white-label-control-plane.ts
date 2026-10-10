import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  WhiteLabelValidationError,
  parseWhiteLabelDraftInput,
  parseWhiteLabelVerificationInput,
} from "../src/lib/white-label-profile-contract";
import { canSelectWhiteLabelProfile } from "../src/components/admin/WhiteLabelReadinessPanel";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const draft = parseWhiteLabelDraftInput({
  profileId: null,
  expectedRevision: 0,
  brandName: "示例内容科技",
  brandShortName: "示例品牌",
  hostname: "AI.Customer-Domain.CN",
  contact: {
    name: "张经理",
    wechat: "example_service",
    phone: "13800000000",
    email: "service@customer-domain.cn",
  },
});

assert.equal(draft.domain.asciiHostname, "ai.customer-domain.cn");
assert.equal(draft.domain.expectedTxtName, "_zimeiti-domain-verification.ai.customer-domain.cn");
assert.equal(draft.contact.wechat, "example_service");
assert.throws(
  () => parseWhiteLabelDraftInput({ ...draft, hostname: "https://ai.customer-domain.cn" }),
  (error: unknown) => error instanceof Error,
  "domain input must not accept a URL",
);
assert.equal(canSelectWhiteLabelProfile(false), true, "a clean draft may select a saved profile");
assert.equal(canSelectWhiteLabelProfile(true), false, "a dirty draft must block even the currently selected profile");
assert.throws(
  () => parseWhiteLabelVerificationInput({ profileId: "not-a-uuid", expectedRevision: 1 }),
  (error: unknown) => error instanceof WhiteLabelValidationError
    && error.code === "WHITE_LABEL_PROFILE_ID_INVALID",
);

const api = read("src/app/api/admin/white-label/route.ts");
const panel = read("src/components/admin/WhiteLabelReadinessPanel.tsx");
const migration = read("supabase/migrations/20261009051000_white_label_draft_control_plane.sql");
const shaCompatMigration = read("supabase/migrations/20261009052000_white_label_dns_sha256_compat.sql");
const environment = read("deploy/environments/production.env.example");

assert.match(api, /authorizeAdminCapability\(request, "white_label\.manage", \{[\s\S]*requireStepUp: true/u);
assert.match(api, /resolveTxt\(target\.expectedTxtName\)/u, "TXT ownership must use a real DNS resolver");
assert.match(api, /observedValuesHash/u, "raw DNS answers must be reduced to evidence hashes before persistence");
assert.match(api, /WHITE_LABEL_CNAME_TARGET/u, "runtime must expose only a configured gateway target");
assert.match(panel, /客户品牌名/u);
assert.match(panel, /微信号/u);
assert.match(panel, /客户域名/u);
assert.match(panel, /beforeunload/u, "unsaved white-label drafts must warn before leaving");
assert.match(panel, /草稿不等于上线/u, "draft persistence must not be presented as live routing");
assert.match(panel, /数据库读回/u, "save success must describe its durability proof");
assert.match(panel, /data-testid="white-label-refresh-authoritative"/u, "white-label settings need an explicit authoritative refresh");
assert.match(panel, /disabled=\{!canSelectWhiteLabelProfile\(dirty\)\}/u, "profile buttons must use the tested dirty-state gate");
assert.doesNotMatch(panel, /dirty && form\.profileId !== profile\.profileId/u, "the current profile must not retain a dirty-state reset loophole");
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.white_label_profiles/u);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.white_label_profile_events/u);
assert.match(migration, /WHITE_LABEL_EVENT_IMMUTABLE/u);
assert.match(migration, /FOR UPDATE/u, "revision checks must serialize concurrent writes");
assert.match(migration, /binding_status, blocked_reason/u, "a draft must start with a blocked runtime binding");
assert.match(migration, /DOMAIN_RUNTIME_NOT_CONNECTED/u);
assert.match(shaCompatMigration, /pg_catalog\.sha256/u, "DNS evidence hashing must work without optional pgcrypto");
assert.doesNotMatch(shaCompatMigration, /CREATE EXTENSION/u, "the control plane must not mutate extension topology");
assert.doesNotMatch(
  migration,
  /UPDATE public\.domain_hostnames SET[\s\S]{0,500}routing_status = 'verified'/u,
  "DNS ownership alone must not claim routing verification",
);
assert.match(environment, /^WHITE_LABEL_CNAME_TARGET=/mu);

console.log(JSON.stringify({
  status: "PASS",
  domainNormalization: draft.domain.asciiHostname,
  saveBoundary: "revision + idempotency + immutable event",
  runtimeBoundary: "dns ownership only; gateway and tls remain blocked",
}, null, 2));
