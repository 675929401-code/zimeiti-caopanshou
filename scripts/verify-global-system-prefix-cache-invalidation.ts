import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getGlobalSystemPrefix,
  invalidateGlobalSystemPrefixCache,
} from "../src/app/api/llm/llm-state";

function fakeClient(value: string, reads: { count: number }) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  reads.count += 1;
                  return { data: { setting_value: value }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

async function main() {
  const firstReads = { count: 0 };
  const secondReads = { count: 0 };
  const firstClient = fakeClient("prefix-before-save", firstReads);
  const secondClient = fakeClient("prefix-after-save", secondReads);

  assert.equal(await getGlobalSystemPrefix(firstClient as never), "prefix-before-save");
  assert.equal(firstReads.count, 1, "首次读取必须访问数据库");
  assert.equal(await getGlobalSystemPrefix(secondClient as never), "prefix-before-save");
  assert.equal(secondReads.count, 0, "TTL 内必须命中已有缓存");
  assert.equal(invalidateGlobalSystemPrefixCache(), undefined, "失效函数不得返回缓存内容");
  assert.equal(await getGlobalSystemPrefix(secondClient as never), "prefix-after-save");
  assert.equal(secondReads.count, 1, "显式失效后下一次读取必须重新访问数据库");

  const root = process.cwd();
  const llmStateSource = readFileSync(resolve(root, "src/app/api/llm/llm-state.ts"), "utf8");
  assert.match(
    llmStateSource,
    /export function invalidateGlobalSystemPrefixCache\(\): void \{\s*globalSystemPrefixCache = \{ value: "", expiry: 0 \};\s*\}/u,
    "失效函数必须清除旧内容且不返回内容",
  );
  assert.doesNotMatch(
    llmStateSource.slice(
      llmStateSource.indexOf("export function invalidateGlobalSystemPrefixCache"),
      llmStateSource.indexOf("// 种子初始化已禁用"),
    ),
    /console\.|return\s+/u,
    "失效函数不得记录或返回全局提示词缓存内容",
  );

  for (const routePath of [
    "src/app/api/settings/admin/route.ts",
    "src/app/api/settings/route.ts",
  ]) {
    const routeSource = readFileSync(resolve(root, routePath), "utf8");
    assert.match(
      routeSource,
      /import \{ invalidateGlobalSystemPrefixCache \} from "@\/app\/api\/llm\/llm-state";/u,
      `${routePath} 必须导入全局提示词缓存失效函数`,
    );
    const calls = routeSource.match(/invalidateGlobalSystemPrefixCache\(\);/gu) || [];
    assert.equal(calls.length, 1, `${routePath} 只能有一个受控缓存失效点`);

    const successfulWrite = routeSource.indexOf('.upsert(');
    const readbackMismatch = routeSource.indexOf("PLATFORM_SETTINGS_READBACK_MISMATCH");
    const changeGuard = routeSource.lastIndexOf(
      'changedKeys.includes("global_system_prefix")',
      routeSource.indexOf("invalidateGlobalSystemPrefixCache();"),
    );
    const invalidation = routeSource.indexOf("invalidateGlobalSystemPrefixCache();");
    assert.ok(successfulWrite >= 0, `${routePath} 必须写入 platform_settings`);
    assert.ok(readbackMismatch > successfulWrite, `${routePath} 必须在数据库写入后校验读回`);
    assert.ok(changeGuard > successfulWrite, `${routePath} 只能在数据库写入成功后进入失效路径`);
    assert.ok(invalidation > changeGuard, `${routePath} 的失效调用必须受 global_system_prefix 真实变更保护`);
    assert.ok(invalidation > readbackMismatch, `${routePath} 只能在数据库读回一致后失效缓存`);

    const guardedSource = routeSource.slice(changeGuard, invalidation);
    assert.doesNotMatch(
      guardedSource,
      /requestedKeys\.includes|keys\.includes|writeKeys\.includes/u,
      `${routePath} 不得因仅提交或验证 global_system_prefix 就清缓存`,
    );
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    assertions: 25,
    cacheRefetchedAfterInvalidation: true,
    writeEntrancesCovered: ["POST /api/settings/admin", "PUT /api/settings"],
    invalidationOrder: "changed -> write -> readback -> invalidate",
    unrelatedSettingsPreserveCache: true,
    promptContentReturnedOrLogged: false,
  }) + "\n");

  // llm-state keeps the application cleanup timer alive; all zero-cost assertions are complete.
  process.exit(0);
}

void main();
