type AgentCatalogRow = {
  category?: unknown;
  user_access?: unknown;
};

type CategoryCatalogRow = {
  name?: unknown;
  visibility?: unknown;
  is_active?: unknown;
};

type NavigationCatalogRow = {
  status?: unknown;
  is_active?: unknown;
};

export function visibleAdminCategoryRows<T extends CategoryCatalogRow>(
  rows: readonly T[],
  includeInternal: boolean,
): T[] {
  if (includeInternal) return [...rows];
  return rows.filter(
    (row) => row.is_active === true
      && row.visibility !== "private"
      && String(row.name || "").trim() !== "自用",
  );
}

export function visibleAdminAgentRows<T extends AgentCatalogRow>(
  rows: readonly T[],
  categories: readonly CategoryCatalogRow[],
  includeInternal: boolean,
): T[] {
  if (includeInternal) return [...rows];
  const publicCategoryNames = new Set(
    visibleAdminCategoryRows(categories, false)
      .map((category) => String(category.name || "").trim())
      .filter(Boolean),
  );
  return rows.filter((row) => {
    if (row.user_access === "hidden") return false;
    return publicCategoryNames.has(String(row.category || "通用").trim());
  });
}

export function visibleAdminNavigationRows<T extends NavigationCatalogRow>(
  rows: readonly T[],
  includeInternal: boolean,
): T[] {
  if (includeInternal) return [...rows];
  return rows.filter((row) => row.is_active === true && row.status !== "hidden");
}
