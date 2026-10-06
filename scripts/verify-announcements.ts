import assert from "node:assert/strict";
import {
  defaultAnnouncementDelivery,
  isAnnouncementActive,
  normalizeAnnouncementDelivery,
  safeAnnouncementUrl,
  type AnnouncementRecord,
} from "../src/lib/announcement-domain";

function record(overrides: Partial<AnnouncementRecord> = {}): AnnouncementRecord {
  return {
    id: "announcement-test",
    title: "测试公告",
    content: "用于验证公告投放规则。",
    is_pinned: false,
    is_active: true,
    created_at: "2026-08-14T00:00:00.000Z",
    push_revision: 1,
    ...defaultAnnouncementDelivery(),
    ...overrides,
  };
}

const normalized = normalizeAnnouncementDelivery({
  priority: "urgent",
  frequency_hours: 0,
  max_impressions: 999,
  target_user_ids: ["user-a", "user-a", "", "user-b"],
});
assert.equal(normalized.priority, "urgent");
assert.equal(normalized.frequency_hours, 1);
assert.equal(normalized.max_impressions, 100);
assert.deepEqual(normalized.target_user_ids, ["user-a", "user-b"]);

assert.equal(
  isAnnouncementActive(record({ target_audience: "authenticated" }), null, new Date("2026-08-14T08:00:00.000Z")),
  false,
);
assert.equal(
  isAnnouncementActive(record({ target_audience: "selected", target_user_ids: ["user-a"] }), { userId: "user-a", role: "student" }, new Date("2026-08-14T08:00:00.000Z")),
  true,
);
assert.equal(
  isAnnouncementActive(record({ status: "scheduled", publish_at: "2026-08-15T00:00:00.000Z" }), null, new Date("2026-08-14T08:00:00.000Z")),
  false,
);
assert.equal(
  isAnnouncementActive(record({ expires_at: "2026-08-14T07:59:00.000Z" }), null, new Date("2026-08-14T08:00:00.000Z")),
  false,
);

assert.equal(safeAnnouncementUrl("javascript:alert(1)"), "");
assert.equal(safeAnnouncementUrl("/help"), "/help");
assert.equal(safeAnnouncementUrl("https://example.com/notice"), "https://example.com/notice");

async function verifyRuntime() {
  const baseUrl = process.env.ANNOUNCEMENT_TEST_BASE_URL || "http://127.0.0.1:5000";
  const publicResponse = await fetch(`${baseUrl}/api/announcements`);
  assert.equal(publicResponse.status, 200);
  const publicData = await publicResponse.json() as { announcements?: AnnouncementRecord[] };
  assert.ok(Array.isArray(publicData.announcements));
  for (const announcement of publicData.announcements || []) {
    assert.ok(announcement.priority);
    assert.ok(announcement.status);
    assert.ok(announcement.target_audience);
  }

  const adminResponse = await fetch(`${baseUrl}/api/announcements?admin=1`);
  assert.equal(adminResponse.status, 401);
  const anonymousEventResponse = await fetch(`${baseUrl}/api/announcements/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(anonymousEventResponse.status, 401);

  console.log(`announcement verification passed (${publicData.announcements?.length || 0} public items)`);
}

void verifyRuntime().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
