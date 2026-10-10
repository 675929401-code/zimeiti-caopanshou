import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/app/announcements/page.tsx", "utf8");

function expect(pattern, message) {
  assert.match(source, pattern, message);
}

expect(/fetch\("\/api\/announcements\/inbox"[\s\S]*?Authorization/u, "认证用户必须优先读取公告收件箱");
expect(/fetch\("\/api\/announcements"[\s\S]*?setReaderMode\("public"\)/u, "匿名或收件箱失败时必须显式降级公开只读");
expect(/不会把公告假装成已读/u, "只读降级必须向用户说明不会伪造已读状态");
expect(/\/api\/announcements\/\$\{encodeURIComponent\(selected\.id\)\}\/read/u, "知道了必须调用账号级公告已读接口");
expect(/body: JSON\.stringify\(\{ revision \}\)/u, "已读确认必须绑定公告版本");
expect(/isCanonicalReadReceipt\(receipt, selected\.id, revision\)/u, "客户端必须校验规范成功回执");
expect(/receipt\.announcementId[\s\S]*?receipt\.revision[\s\S]*?receipt\.readAt/u, "本地已读状态只能使用规范回执更新");
expect(/data-testid="announcement-read-error"/u, "保存失败必须保留可见错误状态");
expect(/data-testid="announcement-previous"/u, "详情页必须提供上一条");
expect(/data-testid="announcement-next"/u, "详情页必须提供下一条");
expect(/data-testid="announcement-position"/u, "详情页必须显示当前条数和总数");
expect(/filtered\.some\(item => item\.id === selectedId\)[\s\S]*?filtered\[0\]\?\.id/u, "筛选变化后必须把选中项收敛到过滤集合");
expect(/if \(loading\) return;[\s\S]*?filtered\.some/u, "加载完成前不得清除 id 深链接");
expect(/searchParams\.get\("id"\)/u, "详情页必须支持 id 深链接");
expect(/overflow-y-auto[^\n]*data-testid="announcement-longform-scroll"/u, "长公告正文必须有独立滚动容器");

function validSelection(items, selectedId) {
  return items.some(item => item.id === selectedId) ? selectedId : items[0]?.id || "";
}

function canonicalReceipt(value, announcementId, revision) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && value.success === true
    && value.announcementId === announcementId
    && value.revision === revision
    && value.status === "read"
    && typeof value.alreadyRead === "boolean"
    && typeof value.readAt === "string"
    && Number.isFinite(Date.parse(value.readAt));
}

const filteredFixture = [{ id: "important-2" }, { id: "important-1" }];
assert.equal(validSelection(filteredFixture, "outside-filter"), "important-2");
assert.equal(validSelection(filteredFixture, "important-1"), "important-1");
assert.equal(validSelection([], "important-1"), "");

const validReceipt = {
  success: true,
  announcementId: "important-2",
  revision: 4,
  readAt: "2026-10-09T12:00:00.000Z",
  alreadyRead: false,
  status: "read",
};
assert.equal(canonicalReceipt(validReceipt, "important-2", 4), true);
assert.equal(canonicalReceipt({ ...validReceipt, announcementId: "other" }, "important-2", 4), false);
assert.equal(canonicalReceipt({ ...validReceipt, revision: 5 }, "important-2", 4), false);
assert.equal(canonicalReceipt({ ...validReceipt, readAt: "invalid" }, "important-2", 4), false);
assert.equal(canonicalReceipt({ ...validReceipt, success: false }, "important-2", 4), false);

console.log(JSON.stringify({
  verifier: "announcement-reading-center",
  assertions: 23,
  networkCalls: 0,
  productionWrites: 0,
}, null, 2));
