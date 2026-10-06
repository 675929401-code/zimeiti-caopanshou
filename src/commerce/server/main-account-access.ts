import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { get } from './store';

export type CommerceSessionRole = 'admin' | 'user';

export interface CurrentCommerceMainAccount {
  id: string;
  username?: string | null;
  display_name?: string | null;
  role?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  member_status?: string | null;
  member_expires_at?: string | null;
}

export interface AuthorizedCommerceMainAccount {
  mainUserId: string;
  username: string;
  role: CommerceSessionRole;
  memberStatus: 'admin' | 'active';
}

export interface CommerceSessionIdentity {
  id: string;
  mainUserId: string;
  role: CommerceSessionRole;
}

interface CommerceMainBinding {
  mainUserId?: string;
  mainRole?: CommerceSessionRole;
  exempt?: boolean;
}

interface CommerceMainAccountAccessDependencies {
  findCurrentAccount: (mainUserId: string) => Promise<CurrentCommerceMainAccount | null>;
  findBinding: (commerceOwnerId: string) => CommerceMainBinding | null;
  now: () => Date;
}

export class CommerceMainAccountAccessError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommerceMainAccountAccessError';
  }
}

function accessError(status: 401 | 403 | 503, code: string, message: string): never {
  throw new CommerceMainAccountAccessError(status, code, message);
}

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function accountName(account: CurrentCommerceMainAccount): string {
  return String(account.username || account.display_name || `user_${account.id.slice(0, 8)}`);
}

function evaluateCurrentAccount(
  account: CurrentCommerceMainAccount | null,
  expectedMainUserId: string,
  now: Date,
): AuthorizedCommerceMainAccount {
  if (!account || account.id !== expectedMainUserId) {
    return accessError(401, 'COMMERCE_ACCOUNT_NOT_FOUND', '主站账户不存在或登录状态已失效');
  }

  const status = normalized(account.status);
  if (account.is_active !== true || (status && status !== 'active')) {
    return accessError(403, 'COMMERCE_ACCOUNT_DISABLED', '主站账户已停用，请联系管理员');
  }

  if (normalized(account.role) === 'admin') {
    return {
      mainUserId: account.id,
      username: accountName(account),
      role: 'admin',
      memberStatus: 'admin',
    };
  }

  if (normalized(account.member_status) !== 'active') {
    return accessError(403, 'COMMERCE_MEMBERSHIP_REQUIRED', '需要有效会员才能使用带货 Agent');
  }

  if (account.member_expires_at) {
    const expiresAt = Date.parse(account.member_expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      return accessError(403, 'COMMERCE_MEMBERSHIP_REQUIRED', '会员已过期，请续费后使用带货 Agent');
    }
  }

  return {
    mainUserId: account.id,
    username: accountName(account),
    role: 'user',
    memberStatus: 'active',
  };
}

/**
 * Build a no-cache account authorizer. Dependency injection keeps the access
 * matrix deterministic in tests; production always reads the current users row.
 */
export function createCommerceMainAccountAccess(dependencies: CommerceMainAccountAccessDependencies) {
  async function authorizeMainAccount(mainUserId: string): Promise<AuthorizedCommerceMainAccount> {
    if (!mainUserId) {
      return accessError(401, 'COMMERCE_ACCOUNT_NOT_FOUND', '主站账户不存在或登录状态已失效');
    }

    let account: CurrentCommerceMainAccount | null;
    try {
      account = await dependencies.findCurrentAccount(mainUserId);
    } catch {
      return accessError(503, 'COMMERCE_ACCOUNT_ACCESS_UNAVAILABLE', '主站账户校验暂不可用，请稍后重试');
    }
    return evaluateCurrentAccount(account, mainUserId, dependencies.now());
  }

  async function authorizeOwner(commerceOwnerId: string): Promise<AuthorizedCommerceMainAccount> {
    let binding: CommerceMainBinding | null;
    try {
      binding = dependencies.findBinding(commerceOwnerId);
    } catch {
      return accessError(503, 'COMMERCE_ACCOUNT_ACCESS_UNAVAILABLE', '主站账户校验暂不可用，请稍后重试');
    }
    if (!binding?.mainUserId) {
      return accessError(403, 'COMMERCE_MAIN_BINDING_REQUIRED', '带货身份尚未绑定主站账户，请重新登录主站');
    }

    const current = await authorizeMainAccount(binding.mainUserId);
    // Older bindings used exempt=true as the admin role marker. Keep reading
    // that shape for authorization only; billing no longer treats it as free.
    const bindingIsAdmin = binding.mainRole
      ? binding.mainRole === 'admin'
      : binding.exempt === true;
    if (bindingIsAdmin !== (current.role === 'admin')) {
      return accessError(403, 'COMMERCE_ACCOUNT_ROLE_CHANGED', '主站账户角色已经变化，请退出后重新进入带货 Agent');
    }
    return current;
  }

  async function authorizeIdentity(identity: CommerceSessionIdentity): Promise<AuthorizedCommerceMainAccount> {
    let binding: CommerceMainBinding | null;
    try {
      binding = dependencies.findBinding(identity.id);
    } catch {
      return accessError(503, 'COMMERCE_ACCOUNT_ACCESS_UNAVAILABLE', '主站账户校验暂不可用，请稍后重试');
    }
    if (!binding?.mainUserId) {
      return accessError(403, 'COMMERCE_MAIN_BINDING_REQUIRED', '带货身份尚未绑定主站账户，请重新登录主站');
    }
    if (!identity.mainUserId || binding.mainUserId !== identity.mainUserId) {
      return accessError(403, 'COMMERCE_SESSION_BINDING_CHANGED', '带货登录对应的主站账户已经变化，请退出后重新进入带货 Agent');
    }

    const current = await authorizeMainAccount(identity.mainUserId);
    const bindingIsAdmin = binding.mainRole
      ? binding.mainRole === 'admin'
      : binding.exempt === true;
    if (bindingIsAdmin !== (current.role === 'admin')) {
      return accessError(403, 'COMMERCE_ACCOUNT_ROLE_CHANGED', '主站账户角色已经变化，请退出后重新进入带货 Agent');
    }
    if (identity.role !== 'user') {
      return accessError(403, 'COMMERCE_SESSION_ROLE_INVALID', '带货产品会话角色无效，请退出后重新进入带货 Agent');
    }
    return current;
  }

  return { authorizeMainAccount, authorizeOwner, authorizeIdentity };
}

const productionAccess = createCommerceMainAccountAccess({
  async findCurrentAccount(mainUserId) {
    const { data, error } = await getSupabaseAdminClient()
      .from('users')
      .select('id, username, display_name, role, status, is_active, member_status, member_expires_at')
      .eq('id', mainUserId)
      .abortSignal(AbortSignal.timeout(10_000))
      .maybeSingle();
    if (error) throw new Error('COMMERCE_MAIN_ACCOUNT_LOOKUP_FAILED');
    return data as CurrentCommerceMainAccount | null;
  },
  findBinding(commerceOwnerId) {
    return get<CommerceMainBinding>('settings', `main-bind-${commerceOwnerId}`, 'system') || null;
  },
  now: () => new Date(),
});

/** Current database row is authoritative; JWT and Commerce cookies are only locators. */
export const authorizeCommerceMainAccount = productionAccess.authorizeMainAccount;

/** Revalidate the bound main-site account on every paid Commerce boundary. */
export const authorizeCurrentCommerceIdentity = productionAccess.authorizeIdentity;
