#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
assert.equal(origin, "http://127.0.0.1:5000", "INVITATION_ROW_ACCEPTANCE_REQUIRES_PRIMARY_LOCAL_PREVIEW");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");

const evidenceDir = path.resolve(".codex-evidence/invitation-person-row/live");
await fs.mkdir(evidenceDir, { recursive: true });
const report = {
  observedAt: new Date().toISOString(),
  origin,
  viewport: { width: 1440, height: 900 },
  policy: { productionWrites: 0, paidCalls: 0, businessWrites: 0 },
  invitations: null,
  adjacentPages: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
  await context.addCookies([
    { name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  await context.addInitScript(({ authToken, authUser }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    sessionStorage.setItem("entered_app", "1");
  }, { authToken: token, authUser: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      report.policy.businessWrites += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(String(error.message).slice(0, 300)));
  page.on("console", (message) => {
    if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED/u.test(message.text())) {
      report.consoleErrors.push(message.text().slice(0, 300));
    }
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "";
    if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/u.test(failure)) return;
    report.requestFailures.push({ method: request.method(), path: new URL(request.url()).pathname, failure });
  });

  const response = await page.goto(`${origin}/admin?tab=invitations`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  assert.equal(response?.status(), 200, "INVITATION_PAGE_HTTP_FAILED");
  await page.getByTestId("admin-invitation-attribution").waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="invitation-attribution-row"]').length > 0,
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1_000);
  const rows = page.getByTestId("invitation-attribution-row");
  const rowCount = await rows.count();
  assert.ok(rowCount >= 2, "AT_LEAST_TWO_INVITATION_ROWS_REQUIRED_FOR_GROUPING_ACCEPTANCE");
  await page.waitForTimeout(500);

  const first = rows.nth(0);
  const second = rows.nth(1);
  assert.equal(await first.getAttribute("data-expanded"), "true", "FIRST_INVITEE_SHOULD_OPEN_BY_DEFAULT");
  assert.equal(await page.getByTestId("invitation-row-details").count(), 1, "EXACTLY_ONE_PERSON_CHAIN_SHOULD_BE_OPEN");

  const layout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="invitation-attribution-row"]')];
    const styles = cards.map((card) => {
      const style = getComputedStyle(card);
      const rect = card.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
        borderStyle: style.borderTopStyle,
        borderRadius: Number.parseFloat(style.borderTopLeftRadius),
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
      };
    });
    return {
      styles,
      gap: styles.length > 1 ? styles[1].top - styles[0].bottom : 0,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    };
  });
  assert.equal(layout.horizontalOverflow, false, "INVITATION_PAGE_MUST_NOT_OVERFLOW_DESKTOP_VIEWPORT");
  assert.ok(layout.styles[0].borderTopWidth >= 1 && layout.styles[0].borderStyle !== "none", "PERSON_ROW_REQUIRES_VISIBLE_BOUNDARY");
  assert.ok(layout.styles[0].borderRadius >= 12, "PERSON_ROW_REQUIRES_COHESIVE_CARD_RADIUS");
  assert.notEqual(layout.styles[0].backgroundColor, "rgba(0, 0, 0, 0)", "PERSON_ROW_REQUIRES_OWN_SURFACE");
  assert.ok(layout.gap >= 8, "ADJACENT_PEOPLE_REQUIRE_VISIBLE_SEPARATION");

  const visualBefore = await second.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      shadow: style.boxShadow,
      transform: style.transform,
      borderColor: style.borderTopColor,
      backgroundColor: style.backgroundColor,
    };
  });
  await second.hover();
  await page.waitForTimeout(250);
  const hoverState = await second.evaluate((node) => ({
    shadow: getComputedStyle(node).boxShadow,
    transform: getComputedStyle(node).transform,
    borderColor: getComputedStyle(node).borderTopColor,
    backgroundColor: getComputedStyle(node).backgroundColor,
    cursor: getComputedStyle(node).cursor,
    hovered: node.matches(":hover"),
  }));
  assert.equal(hoverState.hovered, true, "WHOLE_PERSON_ROW_MUST_RECEIVE_POINTER_HOVER");
  assert.equal(hoverState.cursor, "pointer", "WHOLE_PERSON_ROW_REQUIRES_POINTER_CURSOR");
  assert.ok(
    hoverState.shadow !== visualBefore.shadow
      || hoverState.transform !== visualBefore.transform
      || hoverState.borderColor !== visualBefore.borderColor
      || hoverState.backgroundColor !== visualBefore.backgroundColor,
    "WHOLE_PERSON_ROW_REQUIRES_VISIBLE_HOVER_FEEDBACK",
  );

  await second.click({ position: { x: 26, y: 28 } });
  assert.equal(await first.getAttribute("data-expanded"), "false", "OPENING_NEXT_PERSON_MUST_CLOSE_PREVIOUS_PERSON");
  assert.equal(await second.getAttribute("data-expanded"), "true", "CLICKING_WHOLE_ROW_MUST_OPEN_THAT_PERSON");
  assert.equal(await page.getByTestId("invitation-row-details").count(), 1, "ONLY_ONE_PERSON_DETAILS_SHOULD_REMAIN_OPEN");

  const nestedPackageButton = second.getByTestId("open-member-package");
  await nestedPackageButton.scrollIntoViewIfNeeded();
  await nestedPackageButton.click();
  await page.getByRole("dialog", { name: /会员|套餐/u }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await second.getAttribute("data-expanded"), "true", "NESTED_ACTION_MUST_NOT_COLLAPSE_PERSON_ROW");
  await page.getByRole("button", { name: "关闭套餐窗口" }).click();

  await page.screenshot({ path: path.join(evidenceDir, "invitations-1440x900.png"), fullPage: true });
  report.invitations = { rowCount, layout, hoverState, wholeRowToggle: true, oneOpenAtATime: true, nestedActionIsolation: true };

  for (const target of ["users", "credits"]) {
    const adjacentResponse = await page.goto(`${origin}/admin?tab=${target}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assert.equal(adjacentResponse?.status(), 200, `ADJACENT_${target.toUpperCase()}_HTTP_FAILED`);
    await page.waitForFunction(() => document.body.innerText.trim().length > 120, null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      bodyTextLength: document.body.innerText.trim().length,
    }));
    assert.equal(metrics.horizontalOverflow, false, `ADJACENT_${target.toUpperCase()}_DESKTOP_OVERFLOW`);
    report.adjacentPages.push({ target, http: adjacentResponse.status(), ...metrics });
    await page.screenshot({ path: path.join(evidenceDir, `${target}-1440x900.png`), fullPage: false });
  }

  await context.close();
} finally {
  await browser.close();
}

assert.equal(report.policy.businessWrites, 0, "VISUAL_ACCEPTANCE_MUST_NOT_EXECUTE_BUSINESS_WRITES");
assert.deepEqual(report.pageErrors, [], "PAGE_ERRORS_DETECTED");
assert.deepEqual(report.consoleErrors, [], "CONSOLE_ERRORS_DETECTED");
assert.deepEqual(report.requestFailures, [], "NETWORK_FAILURES_DETECTED");
await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  rowCount: report.invitations.rowCount,
  gap: report.invitations.layout.gap,
  oneOpenAtATime: report.invitations.oneOpenAtATime,
  adjacentPages: report.adjacentPages.map((entry) => entry.target),
  businessWrites: report.policy.businessWrites,
  evidenceDir,
}, null, 2));
