import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getHealthCheckSecret,
  isHealthCheckConfigured,
  matchesHealthCheckSecret,
} from "../src/lib/health-check-auth";
import {
  classifyHealthErrorTrend,
  unavailableHealthErrorTrend,
} from "../src/lib/health-error-trend";
import { readExactCountEvidence } from "../src/lib/health-query-evidence";

const originalSecret = process.env.HEALTH_CHECK_SECRET;

try {
  delete process.env.HEALTH_CHECK_SECRET;
  assert.equal(getHealthCheckSecret(), "");
  assert.equal(isHealthCheckConfigured(), false);
  assert.equal(matchesHealthCheckSecret("anything"), false);

  process.env.HEALTH_CHECK_SECRET = "too-short";
  assert.equal(getHealthCheckSecret(), "");
  assert.equal(matchesHealthCheckSecret("too-short"), false);

  const configuredSecret = "health-monitor-fixture-32-chars-minimum";
  process.env.HEALTH_CHECK_SECRET = configuredSecret;
  assert.equal(isHealthCheckConfigured(), true);
  assert.equal(matchesHealthCheckSecret(configuredSecret), true);
  assert.equal(matchesHealthCheckSecret(`${configuredSecret}-wrong`), false);

  const cronRoute = readFileSync(resolve("src/app/api/health/cron/route.ts"), "utf8");
  const healthRoute = readFileSync(resolve("src/app/api/health/route.ts"), "utf8");
  const adminPage = readFileSync(resolve("src/app/admin/page.tsx"), "utf8");
  const modelAdmin = readFileSync(resolve("src/components/unified-models-tab.tsx"), "utf8");

  assert.doesNotMatch(cronRoute, /agent-hub-health-2024/u);
  assert.doesNotMatch(cronRoute, /searchParams\.get\(['"]secret['"]\)/u);
  assert.doesNotMatch(cronRoute, /CRON_SECRET/u);
  assert.match(cronRoute, /getHealthCheckSecret/u);
  assert.match(cronRoute, /X-Internal-Health-Check/u);
  assert.match(healthRoute, /authorizeAdminCapability\(req, ['"]logs\.view['"]/u);
  assert.doesNotMatch(healthRoute, /authorizeAdminToken/u);
  assert.doesNotMatch(healthRoute, /import\(['"]@\/lib\/auth['"]\)/u);
  assert.match(healthRoute, /automaticRepairEnabled:\s*false/u);
  assert.match(healthRoute, /Promise\.all\(/u);
  assert.match(healthRoute, /classifyHealthErrorTrend\(errorResult, criticalResult\)/u);
  assert.match(healthRoute, /return unavailableHealthErrorTrend\(\)/u);
  assert.doesNotMatch(healthRoute, /无法检查错误趋势（首次运行）/u);
  assert.doesNotMatch(healthRoute, /testCozeConnection/u);
  assert.match(healthRoute, /externalProbeExecuted:\s*false/u);
  assert.match(healthRoute, /private, no-store/u);
  assert.match(healthRoute, /Vary:\s*['"]Authorization, Cookie['"]/u);
  assert.match(healthRoute, /readExactCountEvidence\(studentResult\)/u);
  assert.match(healthRoute, /readExactCountEvidence\(eventResult\)/u);
  assert.doesNotMatch(healthRoute, /activeUsers \|\| 0/u);
  assert.doesNotMatch(healthRoute, /eventCount \|\| 0/u);
  assert.match(healthRoute, /界面不会将查询失败冒充为空记录/u);
  assert.match(healthRoute, /evidenceAvailability/u);
  assert.doesNotMatch(adminPage, /JSON\.stringify\(\{ action: ['"]fix['"] \}\)/u);
  assert.doesNotMatch(adminPage, /执行安全维护/u);
  assert.doesNotMatch(adminPage, /每天自动执行 2-3 次健康检查/u);
  assert.match(modelAdmin, /供应商余额：当前渠道未接入受支持的只读余额接口/u);

  const bootstrapEffectStart = adminPage.search(
    /useEffect\(\(\) => \{\r?\n\s*if \(!userInfo \|\| !adminAccess\) return;/u,
  );
  assert.notEqual(bootstrapEffectStart, -1, "admin bootstrap effect must remain identifiable");
  const bootstrapEffectEnd = adminPage.indexOf(
    "}, [userInfo, adminAccess, canManageAgentConfiguration, readableSettingScopes, sensitiveUnlocked]);",
    bootstrapEffectStart,
  );
  assert.notEqual(bootstrapEffectEnd, -1, "admin bootstrap effect must keep a bounded dependency list");
  const bootstrapEffect = adminPage.slice(bootstrapEffectStart, bootstrapEffectEnd);
  assert.doesNotMatch(bootstrapEffect, /loadHealthData\(|loadSystemLogs\(/u);

  const healthEffectStart = adminPage.lastIndexOf("useEffect(() => {", adminPage.indexOf("void loadHealthData();"));
  const healthEffectEnd = adminPage.indexOf(
    "}, [activeTab, userInfo, adminAccess?.access.permissionKeys]);",
    healthEffectStart,
  );
  assert.notEqual(healthEffectStart, -1, "health loading must live in an effect");
  assert.notEqual(healthEffectEnd, -1, "health loading effect must depend on the active tab and permissions");
  const healthEffect = adminPage.slice(healthEffectStart, healthEffectEnd);
  assert.match(healthEffect, /activeTab !== ["']health["']/u);
  assert.match(healthEffect, /permissionKeys\.includes\(["']logs\.view["']\)/u);
  assert.match(healthEffect, /void loadHealthData\(\);/u);
  assert.match(healthEffect, /void loadSystemLogs\(\);/u);

  assert.deepEqual(
    classifyHealthErrorTrend({ count: null, error: new Error("db") }, { count: 0 }),
    unavailableHealthErrorTrend(),
  );
  for (const invalidCount of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      classifyHealthErrorTrend({ count: invalidCount }, { count: 0 }),
      unavailableHealthErrorTrend(),
    );
    assert.deepEqual(
      classifyHealthErrorTrend({ count: 0 }, { count: invalidCount }),
      unavailableHealthErrorTrend(),
    );
  }
  assert.deepEqual(
    classifyHealthErrorTrend({ count: "3" as unknown as number }, { count: 0 }),
    unavailableHealthErrorTrend(),
  );
  assert.equal(classifyHealthErrorTrend({ count: 0 }, { count: 0 }).status, "healthy");
  assert.equal(classifyHealthErrorTrend({ count: 11 }, { count: 0 }).status, "degraded");
  assert.equal(classifyHealthErrorTrend({ count: 0 }, { count: 1 }).status, "unhealthy");
  assert.equal(unavailableHealthErrorTrend().details.errors, null);

  assert.deepEqual(readExactCountEvidence({ count: 0 }), { available: true, count: 0 });
  assert.deepEqual(readExactCountEvidence({ count: 12 }), { available: true, count: 12 });
  assert.deepEqual(readExactCountEvidence({ count: null }), {
    available: false,
    count: null,
    reason: "invalid_count",
  });
  assert.deepEqual(readExactCountEvidence({ count: 0, error: new Error("db") }), {
    available: false,
    count: null,
    reason: "query_error",
  });
  for (const invalidCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(readExactCountEvidence({ count: invalidCount }).available, false);
  }

  console.log("PASS health monitor authentication, fail-closed evidence, no-store and maintenance boundary");
} finally {
  if (originalSecret === undefined) delete process.env.HEALTH_CHECK_SECRET;
  else process.env.HEALTH_CHECK_SECRET = originalSecret;
}
