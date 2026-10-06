import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ADMIN_SKILL_SOURCE_PERMISSIONS,
  ADMIN_SKILL_WRITE_PERMISSIONS,
  adminSkillSourceRequested,
} from "@/lib/admin-governance";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { SkillAdminActionSchema, SkillAdminQuerySchema } from "@/lib/server/skill-package-contract";
import {
  SkillRepositoryError,
  executeAdminSkillAction,
  listAdminSkillPackages,
  normalizeSkillRepositoryError,
  type AdminSkillPackageView,
} from "@/lib/server/skill-package-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function toSkillPackageMetadata(view: AdminSkillPackageView) {
  const packageItem = view.package;
  return {
    package: {
      id: packageItem.id,
      slug: packageItem.slug,
      display_name: packageItem.display_name,
      summary: packageItem.summary,
      origin: packageItem.origin,
      visibility: packageItem.visibility,
      runtime_kind: packageItem.runtime_kind,
      lifecycle: packageItem.lifecycle,
      active_version_id: packageItem.active_version_id,
      latest_version_number: packageItem.latest_version_number,
      created_at: packageItem.created_at,
      updated_at: packageItem.updated_at,
    },
    versions: view.versions.map((version) => ({
      id: version.id,
      package_id: version.package_id,
      version_number: version.version_number,
      semver: version.semver,
      status: version.status,
      payload_hash: version.payload_hash,
      schema_version: version.schema_version,
      parent_version_id: version.parent_version_id,
      created_at: version.created_at,
      updated_at: version.updated_at,
      published_at: version.published_at,
    })),
  };
}

function invalid(error: z.ZodError, message = "请求参数不合法"): NextResponse {
  return json(
    {
      ok: false,
      code: "INVALID_REQUEST",
      error: message,
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
    400,
  );
}

function failure(error: unknown, operation: string): NextResponse {
  if (error instanceof z.ZodError) return invalid(error);
  const normalized =
    error instanceof SkillRepositoryError
      ? error
      : normalizeSkillRepositoryError(error, operation);
  return json(
    { ok: false, code: normalized.code, error: normalized.message, operation: normalized.operation },
    normalized.status,
  );
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const includeSource = adminSkillSourceRequested(url.searchParams);
  const authorization = await authorizeAdminCapability(
    request,
    includeSource ? ADMIN_SKILL_SOURCE_PERMISSIONS.skillPackages : "agents.view",
    {
      requireStepUp: includeSource,
      operation: includeSource ? "skill_package_source_view" : "skill_package_metadata_view",
    },
  );
  if (!authorization.ok) return authorization.response;
  const parsed = SkillAdminQuerySchema.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    lifecycle: url.searchParams.get("lifecycle") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return invalid(parsed.error, "Skill 管理查询参数不合法");
  try {
    const packages = await listAdminSkillPackages(parsed.data);
    return json({
      ok: true,
      packages: includeSource ? packages : packages.map(toSkillPackageMetadata),
      count: packages.length,
      sourceAccess: includeSource ? "visible" : "protected",
    });
  } catch (error) {
    return failure(error, "admin-list");
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, ADMIN_SKILL_WRITE_PERMISSIONS.skillPackages, {
    requireStepUp: true,
    operation: "skill_packages_manage",
  });
  if (!authorization.ok) return authorization.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, code: "INVALID_JSON", error: "请求体不是有效 JSON" }, 400);
  }
  const parsed = SkillAdminActionSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error, "Skill 管理操作参数不合法");
  try {
    const result = await executeAdminSkillAction(parsed.data, authorization.actor.userId);
    return json({ ok: true, result, sourceAccess: "protected" });
  } catch (error) {
    return failure(error, parsed.data.action);
  }
}
