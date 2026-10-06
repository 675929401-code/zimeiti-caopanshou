export const ADMIN_MEMBER_PERMISSION_MUTATION_FIELDS = [
  'allowedCategories',
  'allowed_categories',
  'allowedNavigationKeys',
  'allowed_navigation_keys',
  'agentNavigationKeys',
  'agent_navigation_keys',
  'featureNavigationKeys',
  'feature_navigation_keys',
  'agentCategories',
  'agent_categories',
  'featureKeys',
  'feature_keys',
  'sourceProfileKey',
  'source_profile_key',
  'permissionProfileKey',
  'permission_profile_key',
] as const;

const ADMIN_MEMBER_PERMISSION_MUTATION_FIELD_SET = new Set<string>(ADMIN_MEMBER_PERMISSION_MUTATION_FIELDS);

export function memberPermissionMutationFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter((key) => ADMIN_MEMBER_PERMISSION_MUTATION_FIELD_SET.has(key));
}

export function canViewAdminMemberBilling(access: {
  authorityStatus?: unknown;
  integrityValid?: unknown;
  permissionKeys?: unknown;
}): boolean {
  return access.authorityStatus === 'ready'
    && access.integrityValid === true
    && Array.isArray(access.permissionKeys)
    && access.permissionKeys.includes('billing.view');
}

export interface AdminMemberBillingFields {
  credits: number;
  cashBalance: number;
  totalCreditRecharge: number;
  totalCashRecharge: number;
  totalCreditConsume: number;
  totalCashConsume: number;
  totalRecharge: number;
  totalConsume: number;
}

export function exposeAdminMemberBilling<T extends Record<string, unknown>>(
  member: T,
  billing: AdminMemberBillingFields,
  allowed: boolean,
): T | (T & AdminMemberBillingFields) {
  return allowed ? { ...member, ...billing } : member;
}
