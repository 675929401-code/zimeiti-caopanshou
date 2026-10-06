import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  articlePublicationIssues,
  buildPublicHelpCatalog,
  createSeedHelpCatalog,
  isSafeHelpAssetPath,
  isSafeReturnPath,
  validateHelpCatalog,
  type HelpArticle,
  type HelpCatalog,
} from "../src/lib/help-center-domain";

const projectRoot = process.cwd();
const expectedPublishedSlugs = new Set([
  "storyboard-prompt-image-video",
  "free-canvas-full-workflow",
  "image-url-and-safe-retry",
]);

function collectKeys(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, result);
    return result;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      result.add(key);
      collectKeys(item, result);
    }
  }
  return result;
}

function assertArticleSections(article: HelpArticle): void {
  assert.ok(article.applicability.trim(), `${article.slug}: 缺少适用场景`);
  assert.ok(article.preparation.length, `${article.slug}: 缺少准备内容`);
  assert.ok(article.steps.length, `${article.slug}: 缺少操作步骤`);
  assert.ok(article.costAndWait.trim(), `${article.slug}: 缺少费用与等待说明`);
  assert.ok(article.successCriteria.length, `${article.slug}: 缺少成功判定`);
  assert.ok(article.failures.length, `${article.slug}: 缺少常见失败`);
  assert.ok(isSafeReturnPath(article.returnPath), `${article.slug}: 返回路径不安全`);
}

async function assertAssets(catalog: HelpCatalog): Promise<void> {
  for (const media of catalog.media) {
    for (const assetPath of [media.assetPath, media.posterPath, media.captionsPath]) {
      assert.ok(isSafeHelpAssetPath(assetPath), `${media.id}: 媒体路径越界`);
      if (!assetPath) continue;
      const localPath = path.join(projectRoot, "public", ...assetPath.split("/").filter(Boolean));
      await readFile(localPath);
    }
  }
}

async function assertRadiusBudget(cssPath: string): Promise<void> {
  const css = await readFile(cssPath, "utf8");
  const values = [...css.matchAll(/border-radius\s*:\s*([0-9.]+)px/gi)].map((match) => Number(match[1]));
  assert.ok(values.length > 0, `${path.basename(cssPath)}: 未找到圆角定义`);
  assert.ok(values.every((value) => value <= 8), `${path.basename(cssPath)}: 存在超过 8px 的圆角`);
}

async function assertPersistenceContract(): Promise<void> {
  const [store, adminRoute] = await Promise.all([
    readFile(path.join(projectRoot, "src/lib/help-center-store.ts"), "utf8"),
    readFile(path.join(projectRoot, "src/app/api/admin/help/route.ts"), "utf8"),
  ]);
  assert.doesNotMatch(store, /\.upsert\s*\(/, "帮助存储不得使用无条件 upsert 覆盖并发更新");
  assert.match(store, /\.insert\(row\)/, "首次持久化应使用唯一键 insert");
  assert.match(store, /\.update\(\{ setting_value: row\.setting_value, updated_at: row\.updated_at \}\)/, "修订应为单次数据库更新");
  assert.match(store, /query\.eq\("updated_at", options\.expectedStorageRevision\)/, "更新必须比对存储版本");
  assert.match(store, /if \(!result\.data\) throw new HelpCatalogConflictError\(\)/, "CAS 未匹配时必须返回冲突");
  assert.match(adminRoute, /clientRevision !== loaded\.catalog\.revision/, "路由必须先校验客户端修订号");
  assert.match(adminRoute, /working\.history = \[/, "当前快照必须与修订一起写入");
  assert.equal((store.match(/\.update\(/g) || []).length, 1, "存储层每次修订只应有一个 update 写入点");
}

async function main(): Promise<void> {
  const catalog = createSeedHelpCatalog();
  const catalogIssues = validateHelpCatalog(catalog);
  assert.deepEqual(catalogIssues, [], `帮助数据校验失败:\n${catalogIssues.join("\n")}`);

  const published = catalog.articles.filter((article) => article.status === "published");
  assert.ok(published.length >= 3, `已发布教程只有 ${published.length} 篇`);
  assert.deepEqual(new Set(published.map((article) => article.slug)), expectedPublishedSlugs);
  for (const article of published) {
    assertArticleSections(article);
    assert.deepEqual(articlePublicationIssues(article, catalog.media), [], `${article.slug}: 不符合发布门槛`);
  }

  const draftCases = catalog.articles.filter((article) => article.articleType === "case");
  assert.ok(draftCases.length >= 2, "应至少保留两个真实案例草稿槽位");
  assert.ok(draftCases.every((article) => article.status === "draft"), "证据未闭环的案例不得发布");
  assert.ok(
    draftCases.every((article) => /(等待|待核验|未发布)/.test(`${article.title}${article.summary}${article.notes}`)),
    "真实案例草稿必须明确标记等待证据",
  );

  const publicCatalog = buildPublicHelpCatalog(
    catalog,
    { authenticated: false, admin: false },
    "",
    new Date("2026-08-14T23:59:59+08:00"),
  );
  assert.equal(publicCatalog.preview, false);
  assert.deepEqual(new Set(publicCatalog.articles.map((article) => article.slug)), expectedPublishedSlugs);
  assert.ok(publicCatalog.articles.every((article) => article.visibility === "public"));

  const publicKeys = collectKeys(publicCatalog);
  for (const forbidden of [
    "trace",
    "verificationStatus",
    "taskId",
    "runId",
    "historyId",
    "artifactPath",
    "sourceRecord",
    "provider",
    "channel",
    "apiKey",
    "secret",
  ]) {
    assert.equal(publicKeys.has(forbidden), false, `公开 DTO 暴露字段: ${forbidden}`);
  }

  const fixtureCatalog = createSeedHelpCatalog();
  const fixtureMedia = {
    ...fixtureCatalog.media[0],
    id: "verified-fixture-must-stay-private",
    sourceKind: "test_fixture" as const,
    verificationStatus: "verified" as const,
  };
  fixtureCatalog.media.push(fixtureMedia);
  fixtureCatalog.articles[0].mediaIds.push(fixtureMedia.id);
  const fixturePublic = buildPublicHelpCatalog(fixtureCatalog, { authenticated: false, admin: false }, "", new Date("2026-08-14T23:59:59+08:00"));
  assert.equal(fixturePublic.media.some((item) => item.id === fixtureMedia.id), false, "验收 fixture 不得进入公开 DTO");

  const firstDraft = catalog.articles.find((article) => article.status === "draft");
  assert.ok(firstDraft, "未找到草稿教程");
  const anonymousPreview = buildPublicHelpCatalog(
    catalog,
    { authenticated: false, admin: false },
    firstDraft.slug,
    new Date("2026-08-14T23:59:59+08:00"),
  );
  assert.equal(anonymousPreview.preview, false, "匿名用户不得预览草稿");
  assert.equal(anonymousPreview.articles.some((article) => article.id === firstDraft.id), false);
  const adminPreview = buildPublicHelpCatalog(
    catalog,
    { authenticated: true, admin: true },
    firstDraft.slug,
    new Date("2026-08-14T23:59:59+08:00"),
  );
  assert.equal(adminPreview.preview, true, "管理员草稿预览未开启");
  assert.deepEqual(adminPreview.articles.map((article) => article.id), [firstDraft.id]);

  assert.equal(isSafeHelpAssetPath("/help/example.png"), true);
  assert.equal(isSafeHelpAssetPath("/help/../secret.txt"), false);
  assert.equal(isSafeHelpAssetPath("https://competitor.example/image.png"), false);
  assert.equal(isSafeReturnPath("/storyboard-workbench"), true);
  assert.equal(isSafeReturnPath("//external.example"), false);

  await assertAssets(catalog);
  await assertRadiusBudget(path.join(projectRoot, "src/app/help/help.module.css"));
  await assertRadiusBudget(path.join(projectRoot, "src/app/admin/help/help-admin.module.css"));
  await assertPersistenceContract();

  console.log(JSON.stringify({
    ok: true,
    publishedTutorials: published.map((article) => ({ slug: article.slug, type: article.articleType })),
    draftCount: catalog.articles.length - published.length,
    draftCases: draftCases.map((article) => article.slug),
    publicMedia: publicCatalog.media.map((media) => ({ id: media.id, evidenceLabel: media.evidenceLabel })),
    checks: ["publication-gate", "dto-redaction", "preview-auth", "safe-paths", "asset-presence", "radius-budget", "single-write-cas"],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
