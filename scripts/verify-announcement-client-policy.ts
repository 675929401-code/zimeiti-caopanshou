import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  announcementAutoDisplayDecision,
  announcementDeliveryKey,
  normalizeAnnouncementDisplayLedger,
  recordAnnouncementImpression,
} from "../src/lib/announcement-client-policy";
import { defaultAnnouncementDelivery, type AnnouncementRecord } from "../src/lib/announcement-domain";

function announcement(overrides: Partial<AnnouncementRecord> = {}): AnnouncementRecord {
  return {
    id: "policy-announcement",
    title: "需要阅读的公告",
    content: "测试公告客户端投放策略",
    is_pinned: false,
    is_active: true,
    created_at: "2026-10-02T00:00:00.000Z",
    push_revision: 3,
    ...defaultAnnouncementDelivery(),
    ...overrides,
  };
}

const start = new Date("2026-10-02T01:00:00.000Z");
const item = announcement({ frequency_hours: 24, max_impressions: 2, require_ack: true });
let ledger = {};
assert.deepEqual(announcementAutoDisplayDecision(item, ledger, start), { eligible: true, reason: "eligible" });

ledger = recordAnnouncementImpression(item, ledger, start);
assert.deepEqual(
  announcementAutoDisplayDecision(item, ledger, new Date("2026-10-02T02:00:00.000Z")),
  { eligible: false, reason: "frequency_window" },
);
assert.deepEqual(
  announcementAutoDisplayDecision(item, ledger, new Date("2026-10-03T02:00:00.000Z")),
  { eligible: true, reason: "eligible" },
);

ledger = recordAnnouncementImpression(item, ledger, new Date("2026-10-03T02:00:00.000Z"));
assert.deepEqual(
  announcementAutoDisplayDecision(item, ledger, new Date("2026-10-05T02:00:00.000Z")),
  { eligible: false, reason: "max_impressions" },
);

const unlimited = announcement({ id: "unlimited", max_impressions: 0, frequency_hours: 1 });
let unlimitedLedger = {};
for (let index = 0; index < 120; index += 1) {
  unlimitedLedger = recordAnnouncementImpression(
    unlimited,
    unlimitedLedger,
    new Date(start.getTime() + index * 2 * 60 * 60 * 1000),
  );
}
assert.equal(
  announcementAutoDisplayDecision(unlimited, unlimitedLedger, new Date(start.getTime() + 241 * 60 * 60 * 1000)).eligible,
  true,
  "max_impressions=0 must remain unlimited while frequency still applies",
);

const repush = { ...item, push_revision: 4 };
assert.notEqual(announcementDeliveryKey(item), announcementDeliveryKey(repush));
assert.equal(announcementAutoDisplayDecision(repush, ledger, start).eligible, true, "a repush starts a new policy revision");

assert.deepEqual(
  normalizeAnnouncementDisplayLedger({
    valid: { impressions: 2, lastImpressionAt: start.toISOString() },
    negative: { impressions: -1, lastImpressionAt: start.toISOString() },
    malformed: "bad",
  }),
  { valid: { impressions: 2, lastImpressionAt: start.toISOString() } },
);

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.resolve(root, file), "utf8");
const popup = read("src/components/announcement-popup.tsx");
const account = read("src/components/account-notification-center.tsx");
const p0 = read("src/components/security-interruption-dialog.tsx");
const layout = read("src/app/layout.tsx");

assert.match(popup, /announcementAutoDisplayDecision/u);
assert.match(popup, /announcement\.require_ack && !isRead\(announcement\)/u);
assert.match(popup, /announcement-inbox-error/u);
assert.match(account, /account-notification-inbox-error/u);
assert.match(p0, /claimAppDialog\(active\.owner, APP_DIALOG_PRIORITY\.security\)/u);
assert.match(layout, /<SecurityInterruptionDialog \/>/u);

console.log(JSON.stringify({
  passed: true,
  checks: 13,
  databaseWrites: 0,
  productionWrites: 0,
}, null, 2));
