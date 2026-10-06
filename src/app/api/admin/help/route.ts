import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { withAdminAuth, type AuthUser } from "@/lib/api-middleware";
import {
  cloneHelpCatalog,
  type HelpArticle,
  type HelpArticleVersion,
  type HelpCatalog,
} from "@/lib/help-center-domain";
import {
  HelpCatalogConflictError,
  loadHelpCatalog,
  prepareCatalogForSave,
  publicationIssues,
  sanitizeHelpArticle,
  saveHelpCatalog,
  type LoadedHelpCatalog,
} from "@/lib/help-center-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};
const MAX_REQUEST_BYTES = 512 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function expectedRevision(value: unknown): number | null {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 1 ? revision : null;
}

function actorLabel(user: AuthUser): string {
  return (user.displayName || user.email || user.id).slice(0, 160);
}

function versionEntry(
  articleId: string,
  revision: number,
  snapshot: HelpArticle | null,
  action: HelpArticleVersion["action"],
  user: AuthUser,
  now: Date,
): HelpArticleVersion {
  return {
    id: `version-${randomUUID()}`,
    articleId,
    revision,
    savedAt: now.toISOString(),
    savedBy: actorLabel(user),
    action,
    snapshot: snapshot ? structuredClone(snapshot) : null,
  };
}

function ensureWritable(loaded: LoadedHelpCatalog): NextResponse | null {
  if (!loaded.error) return null;
  console.error("[admin/help] refusing write after storage read failure:", loaded.error);
  return json({ error: "云端帮助数据读取失败，已阻止写入以避免覆盖" }, 503);
}

async function persist(
  loaded: LoadedHelpCatalog,
  catalog: HelpCatalog,
  supabase: Parameters<typeof loadHelpCatalog>[0],
): Promise<NextResponse> {
  await saveHelpCatalog(supabase, catalog, {
    persisted: loaded.persisted,
    expectedStorageRevision: loaded.storageRevision,
  });
  return json({ catalog, source: "platform_settings" });
}

export async function GET(request: Request) {
  try {
    return await withAdminAuth(request, async (_user, supabase) => {
      const loaded = await loadHelpCatalog(supabase);
      return json({
        catalog: loaded.catalog,
        source: loaded.source,
        warning: loaded.error ? "云端数据暂时不可用，当前仅显示已验证种子内容；修复前禁止保存。" : "",
      });
    });
  } catch (error) {
    console.error("[admin/help] read failed:", error);
    return json({ error: "帮助后台数据读取失败" }, 500);
  }
}

export async function PUT(request: Request) {
  try {
    const requestBytes = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(requestBytes) && requestBytes > MAX_REQUEST_BYTES) {
      return json({ error: "请求内容过大" }, 413);
    }

    return await withAdminAuth(request, async (user, supabase, authenticatedRequest) => {
      const body = await authenticatedRequest.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return json({ error: "请求体不是有效 JSON" }, 400);
      const clientRevision = expectedRevision(body.expectedRevision);
      if (clientRevision === null) return json({ error: "缺少有效 expectedRevision" }, 400);

      const loaded = await loadHelpCatalog(supabase);
      const blocked = ensureWritable(loaded);
      if (blocked) return blocked;
      if (clientRevision !== loaded.catalog.revision) {
        return json({ error: "帮助内容已更新，请刷新后重试", revision: loaded.catalog.revision }, 409);
      }

      const now = new Date();
      if (body.action === "upsertArticle") {
        const rawArticle = body.article && typeof body.article === "object" ? body.article as Record<string, unknown> : null;
        if (!rawArticle) return json({ error: "缺少教程内容" }, 400);
        const requestedId = typeof rawArticle.id === "string" ? rawArticle.id : "";
        const existing = loaded.catalog.articles.find((article) => article.id === requestedId);
        const article = sanitizeHelpArticle(rawArticle, loaded.catalog, existing, now);
        const issues = article.status === "published" ? publicationIssues(article, loaded.catalog) : [];
        if (issues.length) return json({ error: `暂不能发布：${issues.join("；")}`, issues }, 400);

        const working = cloneHelpCatalog(loaded.catalog);
        const index = working.articles.findIndex((item) => item.id === article.id);
        if (index >= 0) working.articles[index] = article;
        else working.articles.push(article);
        working.history = [
          versionEntry(article.id, working.revision, existing || null, existing ? "update" : "create", user, now),
          ...working.history,
        ].slice(0, 60);
        const next = prepareCatalogForSave(working, now);
        return await persist(loaded, next, supabase);
      }

      if (body.action === "rollback") {
        const articleId = typeof body.articleId === "string" ? body.articleId.slice(0, 100) : "";
        const versionId = typeof body.versionId === "string" ? body.versionId.slice(0, 120) : "";
        const current = loaded.catalog.articles.find((article) => article.id === articleId);
        const target = loaded.catalog.history.find((version) => version.id === versionId && version.articleId === articleId);
        if (!current || !target?.snapshot) return json({ error: "回滚目标不存在或不可用" }, 404);

        const restored = sanitizeHelpArticle(target.snapshot, loaded.catalog, current, now);
        const issues = restored.status === "published" ? publicationIssues(restored, loaded.catalog) : [];
        if (issues.length) return json({ error: `目标版本已不符合发布门槛：${issues.join("；")}`, issues }, 400);
        const working = cloneHelpCatalog(loaded.catalog);
        const index = working.articles.findIndex((article) => article.id === articleId);
        working.articles[index] = restored;
        working.history = [
          versionEntry(articleId, working.revision, current, "rollback", user, now),
          ...working.history,
        ].slice(0, 60);
        const next = prepareCatalogForSave(working, now);
        return await persist(loaded, next, supabase);
      }

      return json({ error: "不支持的管理操作" }, 400);
    });
  } catch (error) {
    if (error instanceof HelpCatalogConflictError) return json({ error: error.message }, 409);
    console.error("[admin/help] write failed:", error);
    return json({ error: "帮助内容保存失败" }, 500);
  }
}
