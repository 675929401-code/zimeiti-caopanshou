/** No model override, default model, role or internal workflow can turn an unbound LLM record into an executable card. */
export function isUnboundCatalogAgent(row: { source?: unknown; model_id?: unknown; model?: unknown } | null | undefined): boolean {
  return row?.source === "llm" && !String(row.model_id ?? "").trim() && !String(row.model ?? "").trim();
}

type CatalogAccess = { category?: unknown; user_access?: unknown };
type CategoryAccess = { visibility?: unknown };
export function uniqueAgentCategory<T extends {name:string}>(categories:ReadonlyArray<T> | undefined | null,name:unknown):T|undefined{
  const matches=categories?.filter(c=>c.name===name);
  return matches?.length===1?matches[0]:undefined;
}

export function requiresOwnerAgentAccess(row: CatalogAccess | null | undefined, category: CategoryAccess | undefined): boolean {
  return !!row && (String(row.category ?? "").trim() === "自用" || row.user_access === "hidden" || category?.visibility === "private");
}

export function hasCurrentSelfUseGrant(permission: {revision?:unknown;checksum?:unknown;integrityValid?:unknown;authorityStatus?:unknown;agentNavigationKeys:readonly string[]}): boolean {
  return permission.authorityStatus === "ready" && permission.integrityValid === true && Number(permission.revision) > 0
    && typeof permission.checksum === "string" && !!permission.checksum && permission.checksum !== "legacy-schema-absent"
    && permission.agentNavigationKeys.includes("自用");
}

export function isViewOnlyAgentAccess(row: CatalogAccess | null | undefined, category: CategoryAccess | undefined, allowOwnerSelfUse = false): boolean {
  return !!row && (row.user_access === "view_only" || (category?.visibility === "view_only" && !(allowOwnerSelfUse && row.category === "自用")));
}
