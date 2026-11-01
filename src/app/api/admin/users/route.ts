import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromHeaders, hashPassword, verifyPassword, logPasswordAudit } from '@/lib/auth';
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { getAccountGovernanceInfo, normalizeAccountDisplayName, shouldRejectReservedFixtureIdentity } from '@/lib/account-governance';
import { normalizeDisplayText } from '@/lib/display-normalization';
import { adminPasswordError } from '@/lib/admin-password-policy';
import { adminUserFieldsError, checkAdminUserIdentity } from '@/lib/admin-user-identity';
import { adminUserVerificationKey } from '@/lib/admin-user-verification';
import { authorizeAdminCapability, readAdminAccessSnapshot } from '@/lib/server/admin-governance-authority';
import { verifyCode } from '@/lib/email-code-store';
import { normalizeQqEmail, qqEmailError } from '@/lib/qq-email';
import {
  ADMIN_USER_ACCOUNT_REAUTH_HEADER,
  ADMIN_USER_DELETE_REAUTH_HEADER,
  verifyAdminUserAccountReauth,
  verifyAdminUserDeleteReauth,
} from '@/lib/admin-user-delete-reauth';
import {
  normalizeAllowedAgentCategoryIds,
  normalizeAllowedAgentNavigationKeys,
  resolveAllowedAgentNavigationKeys,
} from '@/lib/agent-category-access';
import {
  canViewAdminMemberBilling,
  exposeAdminMemberBilling,
  memberPermissionMutationFields,
} from '@/lib/admin-member-data-boundary';

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

async function authorizeMemberPermissionMutation(request: NextRequest, body: unknown): Promise<NextResponse | null> {
  const fields = memberPermissionMutationFields(body);
  if (fields.length === 0) return null;

  const authorization = await authorizeAdminCapability(request, 'member_permissions.manage', {
    requireStepUp: true,
    operation: 'member_permissions',
  });
  if (!authorization.ok) return authorization.response;

  // This legacy member route only accepts allowedCategories. The remaining
  // aliases belong to the versioned /users/permissions control plane and must
  // never be silently ignored or interpreted as a different permission type.
  if (fields.some((field) => field !== 'allowedCategories')) {
    return NextResponse.json({
      error: '会员业务权限字段不受此接口支持，请使用会员权限设置入口',
      code: 'MEMBER_PERMISSION_FIELD_UNSUPPORTED',
    }, { status: 400 });
  }
  return null;
}

// GET - List all users (with pagination, search, and member_status)
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('page_size') || searchParams.get('pageSize') || '100');
    const search = searchParams.get('search') || '';
    const clean = (s: unknown) => String(s || '').replace(/[(),]/g, ' ');
    const role = searchParams.get('role');
    const lookupUserId = searchParams.get('user_id') || '';

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    let client: ReturnType<typeof getSupabaseAdminClient>;
    try {
      client = getSupabaseAdminClient();
    } catch (clientError) {
      console.error('Supabase admin client unavailable:', clientError);
      return NextResponse.json({ error: '实时用户数据暂不可用', code: 'REALTIME_DATA_UNAVAILABLE' }, { status: 503 });
    }

    const adminAccess = await readAdminAccessSnapshot(admin.userId);
    const canViewBilling = canViewAdminMemberBilling(adminAccess);
    const buildUsersQuery = (columns: string) => {
      let query = client
        .from('users')
        .select(columns, { count: 'exact' })
        .order('created_at', { ascending: false });

      // Filter by role if specified
      if (role) {
        query = query.eq('role', role);
      }
      // Administrator identities belong to the super-admin control plane.
      // Ordinary member operators never receive other administrator rows, but
      // each administrator must be able to see their own account for the
      // internal wallet recharge flow.
      if (adminAccess.adminLevel !== 'super_admin') {
        query = query.or(`role.neq.admin,id.eq.${clean(admin.userId)}`);
      }

      // Direct user_id lookup (for student profile enrichment)
      if (lookupUserId) {
        query = query.eq('id', lookupUserId);
      }

      // Search filter
      if (search) {
        query = query.or(`display_name.ilike.%${clean(search)}%,phone.ilike.%${clean(search)}%,email.ilike.%${clean(search)}%,username.ilike.%${clean(search)}%`);
      }

      return query.range(from, to);
    };

    const billingColumns = canViewBilling ? ', credits, cash_balance' : '';
    const fullColumns = `id, username, display_name, phone, email, role, is_active, status, member_status, last_sign_in_at, created_at, allowed_categories${billingColumns}`;
    const basicColumns = `id, username, display_name, phone, email, role, is_active, status, member_status, created_at, allowed_categories${billingColumns}`;
    let { data, count, error } = await buildUsersQuery(fullColumns);
    if (error && String(error.message || '').includes('last_sign_in_at')) {
      console.warn('Supabase users query missing last_sign_in_at, retrying with basic columns');
      const fallback = await buildUsersQuery(basicColumns);
      data = fallback.data;
      count = fallback.count;
      error = fallback.error;
    }

    if (error) {
      console.error('Supabase users query error:', error);
      return NextResponse.json({ error: '实时用户数据暂不可用', code: 'REALTIME_DATA_UNAVAILABLE' }, { status: 503 });
    }

    // Map to frontend-friendly format with aggregate recharge/consume data
    const userIds = (data || []).map((u: any) => u.id);

    // Batch query: credit recharge totals per user
    const safeTransactionQuery = async (
      table: 'credit_transactions' | 'cash_transactions',
      types: string[],
    ) => {
      if (userIds.length === 0) return [];
      const query = client.from(table).select('user_id, amount').in('user_id', userIds);
      const result = types.length === 1
        ? await query.eq('type', types[0])
        : await query.in('type', types);
      if (result.error) {
        console.warn(`Admin users aggregate skipped for ${table}:`, result.error.message);
        return [];
      }
      return result.data || [];
    };

    const [creditRechargeData, creditConsumeData, cashRechargeData, cashConsumeData] = canViewBilling
      ? await Promise.all([
          safeTransactionQuery('credit_transactions', ['recharge']),
          safeTransactionQuery('credit_transactions', ['consume', 'consumption']),
          safeTransactionQuery('cash_transactions', ['topup']),
          safeTransactionQuery('cash_transactions', ['consume']),
        ])
      : [[], [], [], []];

    const [navigationCategoriesResult, navigationAgentsResult, memberPermissionsResult] = await Promise.all([
      client.from('categories').select('id, name'),
      client.from('agents').select('id, name, category').is('deleted_at', null),
      userIds.length > 0
        ? client.from('member_permission_assignments').select('user_id,feature_navigation_keys,revision').in('user_id', userIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (navigationCategoriesResult.error || navigationAgentsResult.error || memberPermissionsResult.error) {
      console.error('Admin users permission resolver unavailable:', navigationCategoriesResult.error || navigationAgentsResult.error || memberPermissionsResult.error);
      return NextResponse.json({ error: '智能体导航权限数据暂不可用', code: 'NAVIGATION_AUTHORITY_UNAVAILABLE' }, { status: 503 });
    }
    const navigationCategories = navigationCategoriesResult.data || [];
    const navigationAgents = navigationAgentsResult.data || [];
    const memberPermissionMap = new Map((memberPermissionsResult.data || []).map((row: any) => [String(row.user_id), row]));

    // Aggregate per user
    const creditRechargeMap: Record<string, number> = {};
    const cashRechargeMap: Record<string, number> = {};
    const creditConsumeMap: Record<string, number> = {};
    const cashConsumeMap: Record<string, number> = {};
    (creditRechargeData || []).forEach((t: any) => { creditRechargeMap[t.user_id] = (creditRechargeMap[t.user_id] || 0) + Number(t.amount); });
    (cashRechargeData || []).forEach((t: any) => { cashRechargeMap[t.user_id] = (cashRechargeMap[t.user_id] || 0) + Number(t.amount); });
    (creditConsumeData || []).forEach((t: any) => { creditConsumeMap[t.user_id] = (creditConsumeMap[t.user_id] || 0) + Math.abs(Number(t.amount)); });
    (cashConsumeData || []).forEach((t: any) => { cashConsumeMap[t.user_id] = (cashConsumeMap[t.user_id] || 0) + Math.abs(Number(t.amount)); });

    const users = (data || []).map((u: any) => {
      const memberPermission = memberPermissionMap.get(String(u.id)) as { feature_navigation_keys?: unknown; revision?: unknown } | undefined;
      const allowedNavigationKeys = resolveAllowedAgentNavigationKeys(u.allowed_categories, navigationCategories, navigationAgents);
      const accountFlags = getAccountGovernanceInfo({
        username: u.username,
        display_name: u.display_name,
        phone: u.phone,
        email: u.email,
        role: u.role,
        status: u.status,
        member_status: u.member_status,
        last_sign_in_at: u.last_sign_in_at,
        allowed_categories: u.allowed_categories,
      });
      const member = {
      id: u.id,
      name: normalizeAccountDisplayName({
        username: u.username,
        display_name: u.display_name,
        phone: u.phone,
        email: u.email,
        last_sign_in_at: u.last_sign_in_at,
        allowed_categories: u.allowed_categories,
      }, normalizeDisplayText(u.username, '未知用户')),
      rawName: u.display_name || u.username || '',
      phone: u.phone || '',
      email: u.email || '',
      role: u.role,
      memberStatus: u.member_status || 'inactive',
      status: u.status || (u.is_active === false ? 'suspended' : 'active'),
      isActive: u.is_active,
      // Keep the authoritative ISO instant intact. Formatting on the server can
      // silently use a different timezone from the administrator's browser.
      lastActive: u.last_sign_in_at || '',
      createdAt: u.created_at,
      allowedCategories: allowedNavigationKeys,
      allowedNavigationKeys,
      featureNavigationKeys: Array.isArray(memberPermission?.feature_navigation_keys) ? memberPermission.feature_navigation_keys : [],
      permissionRevision: Number(memberPermission?.revision || 0),
      accountFlags,
      accountKind: accountFlags.isFixture ? 'fixture' : accountFlags.isSuspicious ? 'suspicious' : 'normal',
      accountFlagReasons: accountFlags.reasons,
      };
      return exposeAdminMemberBilling(member, {
        credits: Number(u.credits || 0),
        cashBalance: Number(u.cash_balance || 0),
        totalCreditRecharge: creditRechargeMap[u.id] || 0,
        totalCashRecharge: cashRechargeMap[u.id] || 0,
        totalCreditConsume: creditConsumeMap[u.id] || 0,
        totalCashConsume: cashConsumeMap[u.id] || 0,
        totalRecharge: (creditRechargeMap[u.id] || 0) + (cashRechargeMap[u.id] || 0),
        totalConsume: (creditConsumeMap[u.id] || 0) + (cashConsumeMap[u.id] || 0),
      }, canViewBilling);
    });

    // 管理员账号置顶，测试/验收账号沉底，避免混入真实运营口径。
    users.sort((a: any, b: any) => {
      if (a.role === 'admin' && b.role !== 'admin') return -1;
      if (a.role !== 'admin' && b.role === 'admin') return 1;
      if (a.accountKind === 'fixture' && b.accountKind !== 'fixture') return 1;
      if (a.accountKind !== 'fixture' && b.accountKind === 'fixture') return -1;
      if (a.accountKind === 'suspicious' && b.accountKind === 'normal') return 1;
      if (a.accountKind === 'normal' && b.accountKind === 'suspicious') return -1;
      return 0;
    });

    return NextResponse.json({ users, totalCount: count || 0, page, pageSize });
  } catch (err) {
    console.error('List users error:', err);
    return NextResponse.json({ error: '实时用户数据暂不可用', code: 'REALTIME_DATA_UNAVAILABLE' }, { status: 503 });
  }
}

// POST - Create user
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const permissionAuthorizationError = await authorizeMemberPermissionMutation(request, body);
    if (permissionAuthorizationError) return permissionAuthorizationError;
    const { username, password, displayName, phone, role, credits, allowedCategories, emailVerificationCode } = body;
    const email = normalizeQqEmail(body.email);
    const fieldsError = adminUserFieldsError({ username, displayName, phone, email, role });
    if (fieldsError) return NextResponse.json({ error: fieldsError }, { status: 400 });
    if (allowedCategories !== undefined && allowedCategories !== null && !Array.isArray(allowedCategories)) {
      return NextResponse.json({ error: '智能体导航权限格式无效' }, { status: 400 });
    }
    const requestedNavigationKeys = normalizeAllowedAgentNavigationKeys(allowedCategories);
    if (
      Array.isArray(allowedCategories)
      && requestedNavigationKeys.length !== normalizeAllowedAgentCategoryIds(allowedCategories).length
    ) {
      return NextResponse.json({ error: '包含无效的智能体导航权限' }, { status: 400 });
    }
    const initialCredits = Number(credits || 0);

    const emailError = qqEmailError(email);
    if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });
    if (!displayName) {
      return NextResponse.json({ error: '显示名称不能为空' }, { status: 400 });
    }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      return NextResponse.json({ error: '请输入正确的手机号' }, { status: 400 });
    }
    if (!emailVerificationCode) return NextResponse.json({ error: '请输入QQ邮箱验证码' }, { status: 400 });
    if (shouldRejectReservedFixtureIdentity({ username, displayName, phone, email })) {
      return NextResponse.json({ error: '测试/E2E/验收账号禁止从正式后台写入真实会员库，请使用隔离测试库或本地 fixture。' }, { status: 400 });
    }
    if (initialCredits !== 0) {
      return NextResponse.json({ error: '创建用户时禁止直接写入初始积分；请先创建用户，再通过“积分充值/调整”入口生成可审计流水。' }, { status: 400 });
    }

    const finalUsername = username || phone || email;
    if (finalUsername.length > 64) return NextResponse.json({ error: '用户名不能超过 64 个字符，请单独填写用户名' }, { status: 400 });

    // 密码处理
    const passwordError = adminPasswordError(password);
    if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
    const finalPassword = password as string;
    const passwordHash = await hashPassword(finalPassword);

    // 创建后验证哈希
    const hashCheck = await verifyPassword(finalPassword, passwordHash);
    if (!hashCheck) {
      return NextResponse.json({ error: '密码加密失败，请重试' }, { status: 500 });
    }

    const client = getSupabaseAdminClient();

    const identityError = await checkAdminUserIdentity(client, { username: finalUsername, phone, email });
    if (identityError) return NextResponse.json({ error: identityError.error }, { status: identityError.status });
    const verification = verifyCode(
      email,
      String(emailVerificationCode),
      adminUserVerificationKey('create', admin.userId),
    );
    if (!verification.ok) return NextResponse.json({ error: verification.error }, { status: 400 });

    const finalRole = role || 'student';
    if (finalRole === 'admin') {
      return NextResponse.json({
        error: '管理员账号只能由超级管理员在“超级管理”中创建',
        code: 'ADMIN_ACCOUNT_CONTROL_PLANE_REQUIRED',
      }, { status: 403 });
    }
    const insertData: Record<string, unknown> = {
      username: finalUsername,
      password_hash: passwordHash,
      display_name: displayName,
      role: finalRole,
      credits: 0,
      is_active: true,
      status: 'active',
    };
    if (phone) insertData.phone = phone;
    insertData.email = email;
    // Ordinary users always use an explicit Agent navigation allow-list.
    insertData.allowed_categories = finalRole === 'admin' ? null : requestedNavigationKeys;

    const { data, error } = await client
      .from('users')
      .insert(insertData)
      .select('id, username, display_name, phone, email, role, is_active, status, created_at, allowed_categories')
      .single();

    if (error) {
      if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
        return NextResponse.json({ error: '用户名、手机号或邮箱已被其他账号使用' }, { status: 409 });
      }
      return NextResponse.json({ error: `创建用户失败: ${error.message}` }, { status: 500 });
    }

    // 🔒 密码审计：管理员创建用户
    await logPasswordAudit({
      userId: data.id,
      action: 'admin_create',
      performedById: admin.userId,
      performedByRole: admin.role,
      performedByName: admin.displayName,
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      details: '管理员创建用户并设置初始密码',
    });

    return NextResponse.json({
      success: true,
      user: data,
    });
  } catch (err) {
    console.error('Create user error:', err);
    return NextResponse.json({ error: `创建用户失败: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}

// PUT - Update user (including reset password)
export async function PUT(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const permissionAuthorizationError = await authorizeMemberPermissionMutation(request, body);
    if (permissionAuthorizationError) return permissionAuthorizationError;
    const { userId, displayName, phone, role, is_active, status, credits, newPassword, resetPassword, allowedCategories, memberStatus } = body;
    const username = body.username === undefined ? undefined : String(body.username).trim();
    const email = body.email === undefined ? undefined : normalizeQqEmail(body.email);
    const fieldsError = adminUserFieldsError({ username, displayName, phone, email, role });
    if (fieldsError) return NextResponse.json({ error: fieldsError }, { status: 400 });
    if (allowedCategories !== undefined && allowedCategories !== null && !Array.isArray(allowedCategories)) {
      return NextResponse.json({ error: '智能体导航权限格式无效' }, { status: 400 });
    }
    const requestedNavigationKeys = normalizeAllowedAgentNavigationKeys(allowedCategories);
    if (
      Array.isArray(allowedCategories)
      && requestedNavigationKeys.length !== normalizeAllowedAgentCategoryIds(allowedCategories).length
    ) {
      return NextResponse.json({ error: '包含无效的智能体导航权限' }, { status: 400 });
    }

    if (!userId) {
      return NextResponse.json({ error: '用户ID不能为空' }, { status: 400 });
    }
    if (credits !== undefined) {
      return NextResponse.json({ error: '禁止通过用户资料接口直接修改积分；请使用“积分充值/调整”入口，确保流水与审计同步。' }, { status: 400 });
    }

    const client = getSupabaseAdminClient();
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

    const { data: targetUser, error: targetError } = await client
      .from('users')
      .select('username, display_name, phone, email, role, status, is_active, member_status, last_sign_in_at, allowed_categories')
      .eq('id', userId)
      .maybeSingle();
    if (targetError) return NextResponse.json({ error: '暂时无法读取用户，请稍后重试' }, { status: 503 });
    if (!targetUser) return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    if (targetUser.role === 'admin' || role === 'admin') {
      return NextResponse.json({
        error: '管理员资料与授权只能在“超级管理”中修改',
        code: 'ADMIN_ACCOUNT_CONTROL_PLANE_REQUIRED',
      }, { status: 403 });
    }
    if (email !== undefined) {
      const emailError = qqEmailError(email);
      if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });
      if (email !== normalizeQqEmail(targetUser.email)) {
        return NextResponse.json({
          error: '安全邮箱是永久身份凭据，后台也不能改写；未绑定用户须由本人完成邮箱验证',
          code: 'EMAIL_IMMUTABLE',
        }, { status: 409 });
      }
    }
    if (phone !== undefined && String(phone || '').trim() !== String(targetUser.phone || '').trim()) {
      return NextResponse.json({
        error: '更换手机号必须由账号本人验证当前QQ安全邮箱，后台资料接口不能绕过',
        code: 'PHONE_CHANGE_REQUIRES_EMAIL_VERIFICATION',
      }, { status: 409 });
    }
    if (username !== undefined || phone !== undefined || email !== undefined) {
      const identityError = await checkAdminUserIdentity(client, { username, phone, email }, userId);
      if (identityError) return NextResponse.json({ error: identityError.error }, { status: identityError.status });
    }
    const targetGovernance = getAccountGovernanceInfo(targetUser || {});
    const requestedReservedFixtureIdentity = shouldRejectReservedFixtureIdentity({
      username: targetUser?.username,
      displayName: displayName ?? targetUser?.display_name,
      phone: phone ?? targetUser?.phone,
      email: email ?? targetUser?.email,
    });
    if (!targetGovernance.isFixture && requestedReservedFixtureIdentity) {
      return NextResponse.json({ error: '禁止把真实会员账号改成测试/E2E/验收身份；测试请使用隔离测试库。' }, { status: 400 });
    }
    if (
      targetGovernance.isFixture
      && (role === 'admin' || status === 'active' || memberStatus === 'active')
    ) {
      return NextResponse.json({ error: '该账号已识别为测试/验收账号，禁止提升为管理员或激活为正式会员；请保留证据后隔离/删除。' }, { status: 400 });
    }

    // Membership lifecycle is its own auditable workflow.  It must update the
    // invitation activation projection atomically and must never be mixed with
    // profile/password edits in the same request.
    if (memberStatus !== undefined) {
      const membershipOnlyKeys = new Set([
        'userId', 'memberStatus', 'activationMethod', 'activationReference',
        'activationFee', 'activationNote', 'idempotencyKey',
      ]);
      if (Object.keys(body).some((key) => !membershipOnlyKeys.has(key))) {
        return NextResponse.json({ error: '会员激活必须单独确认，不能与资料或权限修改合并提交' }, { status: 400 });
      }
      if (!['inactive', 'trial', 'active', 'expired'].includes(memberStatus)) {
        return NextResponse.json({ error: '无效的会员状态' }, { status: 400 });
      }
      if (memberStatus === 'active') {
        return NextResponse.json({
          error: '正式会员激活必须通过“线下收款”核验到账，或由学员兑换已绑定会员卡；用户资料接口不允许绕过财务凭证直接激活',
          code: 'MEMBER_ACTIVATION_REQUIRES_EVIDENCE',
        }, { status: 409 });
      }
      const requestKey = String(request.headers.get('idempotency-key') || body.idempotencyKey || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(requestKey)) {
        return NextResponse.json({ error: '缺少有效的会员操作编号，本次未修改' }, { status: 400 });
      }
      const activationFee = null;
      if (activationFee !== null && (!Number.isFinite(activationFee) || activationFee < 0)) {
        return NextResponse.json({ error: '实收学费金额无效' }, { status: 400 });
      }
      const { data: receipt, error: activationError } = await client.rpc('set_member_activation_state_atomic', {
        p_admin_id: admin.userId,
        p_user_id: userId,
        p_member_status: memberStatus,
        p_activation_method: null,
        p_activation_reference: typeof body.activationReference === 'string' ? body.activationReference : null,
        p_activation_fee: activationFee,
        p_activation_note: typeof body.activationNote === 'string' ? body.activationNote : '',
        p_idempotency_key: requestKey,
      });
      if (activationError) {
        const migrationMissing = ['PGRST202', '42883', '42P01', '42703'].includes(String(activationError.code || ''));
        return NextResponse.json({
          error: migrationMissing ? '会员激活迁移尚未就绪，本次未修改' : '会员状态修改失败，请保留原操作编号核对后重试',
          code: migrationMissing ? 'MEMBER_ACTIVATION_MIGRATION_NOT_READY' : 'MEMBER_ACTIVATION_FAILED',
        }, { status: 503 });
      }
      const activationReceipt = receipt as Record<string, unknown> | null;
      if (activationReceipt?.success !== true) {
        const code = typeof activationReceipt?.code === 'string' ? activationReceipt.code : 'MEMBER_ACTIVATION_FAILED';
        const statusCode = code.endsWith('_CONFLICT') ? 409 : code.includes('NOT_FOUND') ? 404 : 400;
        return NextResponse.json({ error: '会员状态修改未通过业务校验', code }, { status: statusCode });
      }
      return NextResponse.json({ success: true, idempotencyKey: requestKey, activation: activationReceipt });
    }

    if (displayName !== undefined) updateData.display_name = displayName;
    if (phone !== undefined) updateData.phone = phone;
    const changesUsername = username !== undefined && username !== targetUser.username;
    if (changesUsername) updateData.username = username;
    if (role !== undefined) updateData.role = role;
    if (is_active !== undefined) updateData.is_active = is_active;
    const effectiveRole = role ?? targetUser.role;
    if (effectiveRole === 'admin') {
      updateData.allowed_categories = null;
    } else if (allowedCategories !== undefined) {
      updateData.allowed_categories = requestedNavigationKeys;
    } else if (targetUser.role === 'admin' && effectiveRole !== 'admin') {
      // A demoted administrator must start without implicit Agent access.
      updateData.allowed_categories = [];
    }

    // 新的 status 字段支持：active / suspended / blocked
    if (status !== undefined) {
      if (!['active', 'suspended', 'blocked'].includes(status)) {
        return NextResponse.json({ error: '无效的状态值' }, { status: 400 });
      }
      updateData.status = status;
      // 同步 is_active 以保持兼容
      updateData.is_active = status === 'active';
    }

    const changesPassword = newPassword !== undefined || resetPassword === true;
    const changesLoginIdentity = changesUsername || changesPassword;
    const changesAccountAuthority = (role !== undefined && role !== targetUser.role)
      || (status !== undefined && status !== targetUser.status)
      || (is_active !== undefined && is_active !== targetUser.is_active);
    if (changesLoginIdentity) {
      const recoveryVerification = request.headers.get(ADMIN_USER_ACCOUNT_REAUTH_HEADER);
      if (!(await verifyAdminUserAccountReauth(recoveryVerification, admin))) {
        return NextResponse.json({
          error: '请先验证管理员操作密码，再修改学员账号或密码',
          code: 'ADMIN_USER_ACCOUNT_REAUTH_REQUIRED',
        }, { status: 403 });
      }
      // Any login identity or password recovery invalidates every old device.
    }
    // Role changes, disabling and re-enabling also invalidate every old device;
    // otherwise a still-signed JWT could regain access when an account is restored.
    if (changesLoginIdentity || changesAccountAuthority) updateData.session_id = null;
    if (changesPassword) {
      const passwordError = adminPasswordError(newPassword);
      if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
      updateData.password_hash = await hashPassword(newPassword);
    }

    const { data, error } = await client
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select('id, username, display_name, phone, email, role, is_active, status, allowed_categories')
      .single();

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: '用户名、手机号或邮箱已被其他账号使用' }, { status: 409 });
      return NextResponse.json({ error: `更新用户失败: ${error.message}` }, { status: 500 });
    }
    if (changesPassword) {
      await logPasswordAudit({
        userId,
        action: resetPassword === true ? 'admin_reset' : 'admin_update',
        performedById: admin.userId,
        performedByRole: admin.role,
        performedByName: admin.displayName,
        ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        details: resetPassword === true ? '管理员重置用户密码' : '管理员修改用户密码',
      });
    }
    return NextResponse.json({ success: true, user: data });
  } catch (err) {
    console.error('Update user error:', err);
    return NextResponse.json({ error: '更新用户失败' }, { status: 500 });
  }
}

// DELETE - Delete user
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('id');

    if (!userId) {
      return NextResponse.json({ error: '用户ID不能为空' }, { status: 400 });
    }

    if (userId === admin.userId) {
      return NextResponse.json({ error: '不能删除自己的账号' }, { status: 400 });
    }

    const deletionVerification = request.headers.get(ADMIN_USER_DELETE_REAUTH_HEADER);
    if (!await verifyAdminUserDeleteReauth(deletionVerification, admin)) {
      return NextResponse.json(
        {
          error: '删除验证已失效，请重新验证管理员密码',
          code: 'ADMIN_USER_DELETE_REAUTH_REQUIRED',
        },
        { status: 428 },
      );
    }

    // 🔒 管理员账号不可删除
    const client = getSupabaseAdminClient();
    const { data: targetUser } = await client
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (targetUser?.role === 'admin') {
      return NextResponse.json({ error: '管理员账号不可删除' }, { status: 403 });
    }

    const { error } = await client.from('users').delete().eq('id', userId);
    if (error) {
      return NextResponse.json({ error: `删除用户失败: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    return NextResponse.json({ error: '删除用户失败' }, { status: 500 });
  }
}
