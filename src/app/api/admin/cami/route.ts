import { NextRequest, NextResponse } from 'next/server';
import {
  normalizeAllowedAgentCategoryIds,
  normalizeAllowedAgentNavigationKeys,
  resolveAllowedAgentNavigationKeys,
} from '@/lib/agent-category-access';
import { getTokenFromHeaders } from '@/lib/auth';
import { verifyAdminToken } from "@/lib/admin-auth";
import { randomBytes } from 'crypto';
import { getAccountGovernanceInfo } from '@/lib/account-governance';
import { hasAdminPermissionRequirement } from '@/lib/admin-governance';
import {
  ADMIN_CAMI_ASSIGNMENT_REAUTH_HEADER,
  verifyAdminCamiAssignmentReauth,
} from '@/lib/admin-user-delete-reauth';
import { normalizeFeatureNavigationKeys } from '@/lib/member-permissions';
import {
  readAdminAccessSnapshot,
  type AdminAccessSnapshot,
} from '@/lib/server/admin-governance-authority';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

type CamiAdditionalAuthorization =
  | { ok: true; access: AdminAccessSnapshot }
  | { ok: false; response: NextResponse };

async function requireAdditionalCamiPermissions(
  adminId: string,
  requiredPermissionKeys: readonly string[],
): Promise<CamiAdditionalAuthorization> {
  const access = await readAdminAccessSnapshot(adminId);
  if (access.authorityStatus !== 'ready' || !access.integrityValid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: '后台授权档案暂不可用，本次操作未放行', code: 'ADMIN_AUTHORITY_NOT_READY' },
        { status: 503 },
      ),
    };
  }
  if (!hasAdminPermissionRequirement(access.permissionKeys, requiredPermissionKeys)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: '当前管理员无权执行此操作', code: 'ADMIN_PERMISSION_DENIED' },
        { status: 403 },
      ),
    };
  }
  return { ok: true, access };
}

function generateCamiCode(prefix: string = 'AH'): string {
  // 更复杂的卡密生成算法：
  // 1. 更大字符集（去掉易混淆的 I/O/0/1，加入小写字母增加熵）
  // 2. 更长格式：XX-XXXX-XXXX-XXXX-XXXX-XX（前缀2 + 4段4字符 + 校验2字符 = 24字符含分隔符）
  // 3. 校验位：最后2字符是前面所有字符的 CRC8 校验，防止输错
  const upperChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const lowerChars = 'abcdefghjkmnpqrstuvwxyz';
  const allChars = upperChars + lowerChars;

  let code = prefix + '-';
  let payload = prefix;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const ch = allChars[randomBytes(1)[0] % allChars.length];
      code += ch;
      payload += ch;
    }
    if (i < 3) code += '-';
  }

  // 计算 CRC8 校验位（2个字符）
  let crc = 0;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xFF;
      } else {
        crc = (crc << 1) & 0xFF;
      }
    }
  }
  code += '-' + upperChars[Math.floor(crc / upperChars.length)] + upperChars[crc % upperChars.length];

  return code;
}

// 直接使用 REST API 操作 cami_codes 表（绕过 supabase-js schema cache 问题）
async function camiRestApi(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<{ data: unknown; error: string | null }> {
  // 🔒 安全修复：不再硬编码密钥，仅从环境变量读取
  const supabaseUrl = process.env.COZE_SUPABASE_URL;
  const supabaseKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return { data: null, error: "数据库配置缺失，请联系管理员" };
  }

  const headers: Record<string, string> = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  const url = `${supabaseUrl}/rest/v1/${path}`;
  const fetchOptions: RequestInit = { method, headers };

  if (body && (method === 'POST' || method === 'PATCH')) {
    fetchOptions.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    if (!response.ok) {
      // If schema cache miss, try with reload header
      if (text.includes('schema cache')) {
        headers['Prefer'] = 'schema-cache-reload,return=representation';
        const retryResponse = await fetch(url, { method, headers, body: fetchOptions.body });
        const retryText = await retryResponse.text();
        if (!retryResponse.ok) {
          return { data: null, error: retryText };
        }
        try {
          return { data: JSON.parse(retryText), error: null };
        } catch {
          return { data: retryText, error: null };
        }
      }
      return { data: null, error: text };
    }

    try {
      return { data: JSON.parse(text), error: null };
    } catch {
      return { data: text || null, error: null };
    }
  } catch (err) {
    return { data: null, error: (err as Error).message };
  }
}

// GET /api/admin/cami - 查询卡密列表
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '无权限' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const memberId = searchParams.get('member_id')?.trim() || '';
  if (memberId) {
    const authorization = await requireAdditionalCamiPermissions(admin.userId, ['members.view', 'packages.manage']);
    if (!authorization.ok) return authorization.response;
    const canViewBilling = hasAdminPermissionRequirement(authorization.access.permissionKeys, 'billing.view');
    const database = getSupabaseAdminClient();
    const paymentResultPromise = canViewBilling
      ? database
        .from('offline_payment_receipts')
        .select('id,status,business_type,amount,paid_at,payment_channel')
        .eq('user_id', memberId)
        .order('paid_at', { ascending: false })
        .limit(20)
      : Promise.resolve(null);
    const [userResult, packageResult, pendingCardResult, invitationResult, paymentResult] = await Promise.all([
      database
        .from('users')
        .select('id,username,display_name,phone,email,member_status,member_expires_at,created_at,last_sign_in_at,role,status,is_active')
        .eq('id', memberId)
        .maybeSingle(),
      database
        .from('member_package_assignments')
        .select('id,package_name,membership_status,member_expires_at,profile_key,profile_version,created_at,notification_id')
        .eq('user_id', memberId)
        .order('created_at', { ascending: false })
        .limit(20),
      database
        .from('cami_codes')
        .select('id,plan_name,profile_key,profile_version,assigned_at,expires_at')
        .eq('assigned_to', memberId)
        .eq('is_used', false)
        .order('assigned_at', { ascending: false })
        .limit(10),
      database
        .from('invitation_records')
        .select('id,inviter_id,invited_at,invitee_activated,activated_at')
        .eq('invitee_id', memberId)
        .order('invited_at', { ascending: false })
        .limit(1),
      paymentResultPromise,
    ]);
    if (userResult.error) return NextResponse.json({ error: '暂时无法读取学员状态' }, { status: 503 });
    if (!userResult.data || userResult.data.role === 'admin') return NextResponse.json({ error: '学员不存在' }, { status: 404 });
    if (packageResult.error || pendingCardResult.error || invitationResult.error || paymentResult?.error) {
      return NextResponse.json({ error: '学员套餐闭环数据暂不可用' }, { status: 503 });
    }
    const packages = (packageResult.data || []) as Array<{
      id: string;
      package_name?: string | null;
      membership_status?: string | null;
      member_expires_at?: string | null;
      profile_key?: string | null;
      profile_version?: number | null;
      created_at?: string | null;
      notification_id?: string | null;
    }>;
    const payments = (paymentResult?.data || []) as Array<{
      id: string;
      status?: string | null;
      business_type?: string | null;
      amount?: number | null;
      paid_at?: string | null;
      payment_channel?: string | null;
    }>;
    const confirmedTuition = payments.find((receipt) => receipt.status === 'confirmed' && receipt.business_type === 'membership_tuition') || null;
    const trialAssignment = packages.find((assignment) => assignment.membership_status === 'trial') || null;
    return NextResponse.json({
      member: userResult.data,
      packageState: {
        current: packages[0] || null,
        trialDelivered: Boolean(trialAssignment),
        trialAssignment,
        pendingCards: pendingCardResult.data || [],
        invitation: invitationResult.data?.[0] || null,
        ...(canViewBilling ? { confirmedOfflinePayment: confirmedTuition } : {}),
      },
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  }
  const page = parseInt(searchParams.get('page') || '1');
  const size = parseInt(searchParams.get('size') || '20');
  const batchId = searchParams.get('batch_id');
  const isUsed = searchParams.get('is_used');

  let path = `cami_codes?select=*&order=created_at.desc&offset=${(page - 1) * size}&limit=${size}`;
  if (batchId) path += `&batch_id=eq.${encodeURIComponent(batchId)}`;
  if (isUsed !== null && isUsed !== '') path += `&is_used=eq.${isUsed === 'true'}`;

  // Get count
  let countPath = 'cami_codes?select=id';
  if (batchId) countPath += `&batch_id=eq.${encodeURIComponent(batchId)}`;
  if (isUsed !== null && isUsed !== '') countPath += `&is_used=eq.${isUsed === 'true'}`;

  const [dataResult, countResult, categoriesResult, agentsResult] = await Promise.all([
    camiRestApi('GET', path),
    camiRestApi('GET', countPath),
    camiRestApi('GET', 'categories?select=id,name'),
    camiRestApi('GET', 'agents?select=id,name,category&deleted_at=is.null'),
  ]);

  if (dataResult.error) return NextResponse.json({ error: dataResult.error }, { status: 500 });

  const legacyCategories = Array.isArray(categoriesResult.data)
    ? categoriesResult.data as Array<{ id: string; name: string }>
    : [];
  const agents = Array.isArray(agentsResult.data)
    ? agentsResult.data as Array<{ id: string; name: string; category: string | null }>
    : [];
  const codes = (Array.isArray(dataResult.data) ? dataResult.data : []).map((rawCode) => {
    const code = rawCode as Record<string, unknown>;
    const storedGrants = normalizeAllowedAgentCategoryIds(code.allowed_categories);
    const stableGrants = normalizeAllowedAgentNavigationKeys(storedGrants);
    const resolvedGrants = resolveAllowedAgentNavigationKeys(storedGrants, legacyCategories, agents);
    const containsLegacyGrant = storedGrants.length > stableGrants.length;
    const permissionStatus = storedGrants.length === 0
      ? 'none'
      : resolvedGrants.length === 0
        ? 'legacy-unresolved'
        : containsLegacyGrant
          ? 'legacy-resolved'
          : 'stable';

    return {
      ...code,
      allowed_categories: resolvedGrants.length > 0 ? resolvedGrants : null,
      allowed_categories_status: permissionStatus,
    };
  });
  const total = Array.isArray(countResult.data) ? countResult.data.length : 0;

  return NextResponse.json({
    codes,
    total,
    page,
    size,
  });
}

// POST /api/admin/cami - 批量生成卡密
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '无权限' }, { status: 403 });
  const authorization = await requireAdditionalCamiPermissions(admin.userId, ['packages.manage']);
  if (!authorization.ok) return authorization.response;

  const body = await request.json();
  const {
    count = 1,
    profileKey = '',
    profileVersion = 0,
    expires_days = 0,
    prefix = 'AH',
  } = body;

  const numericCount = Number(count);
  const numericExpiry = Number(expires_days);
  const normalizedProfileKey = String(profileKey || '').trim().toLowerCase();
  const numericProfileVersion = Number(profileVersion);

  if (!Number.isInteger(numericCount) || numericCount < 1 || numericCount > 500) {
    return NextResponse.json({ error: '数量须在1-500之间' }, { status: 400 });
  }
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(normalizedProfileKey)
    || !Number.isInteger(numericProfileVersion) || numericProfileVersion <= 0
    || !Number.isInteger(numericExpiry) || numericExpiry < 0 || numericExpiry > 36500) {
    return NextResponse.json({ error: '请选择有效的正式会员或超级 VIP 套餐，并检查卡密有效期' }, { status: 400 });
  }
  const database = getSupabaseAdminClient();
  const { data: profile, error: profileError } = await database
    .from('member_permission_profiles')
    .select('profile_key,version,name,membership_status,duration_days,credits,cash_amount,feature_navigation_keys,agent_navigation_keys,is_active,is_selectable')
    .eq('profile_key', normalizedProfileKey)
    .eq('version', numericProfileVersion)
    .eq('is_active', true)
    .eq('is_selectable', true)
    .maybeSingle();
  if (profileError) return NextResponse.json({ error: '套餐模板暂时无法读取' }, { status: 503 });
  if (!profile || profile.membership_status !== 'active') {
    return NextResponse.json({ error: '激活卡只能绑定正式会员或超级 VIP 套餐；体验包请在邀请关系中派发' }, { status: 400 });
  }
  const featureNavigationKeys = normalizeFeatureNavigationKeys(profile.feature_navigation_keys);
  const navigationKeys = normalizeAllowedAgentNavigationKeys(profile.agent_navigation_keys);
  const batchId = `BATCH-${Date.now()}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const expiresAt = numericExpiry > 0 ? new Date(Date.now() + numericExpiry * 24 * 60 * 60 * 1000).toISOString() : null;

  const codes: Array<{
    code: string;
    credits: number;
    cash_balance: number;
    duration_days: number;
    plan_name: string;
    batch_id: string;
    expires_at: string | null;
    allowed_categories: string[] | null;
    feature_navigation_keys: string[];
    profile_key: string;
    profile_version: number;
    created_by: string;
  }> = [];

  for (let i = 0; i < numericCount; i++) {
    codes.push({
      code: generateCamiCode(prefix),
      credits: Number(profile.credits || 0),
      cash_balance: Number(profile.cash_amount || 0),
      duration_days: Number(profile.duration_days || 0),
      plan_name: String(profile.name || '会员套餐'),
      batch_id: batchId,
      expires_at: expiresAt,
      allowed_categories: navigationKeys.length > 0 ? navigationKeys : null,
      feature_navigation_keys: featureNavigationKeys,
      profile_key: normalizedProfileKey,
      profile_version: numericProfileVersion,
      created_by: admin.userId,
    });
  }

  const { data, error } = await camiRestApi('POST', 'cami_codes', codes as unknown as Record<string, unknown>);
  if (error) return NextResponse.json({ error }, { status: 500 });

  const insertedCodes = Array.isArray(data) ? data : [];
  return NextResponse.json({
    success: true,
    batch_id: batchId,
    created: insertedCodes.length,
    codes: insertedCodes.map((c: Record<string, unknown>) => c.code),
    package: {
      profileKey: normalizedProfileKey,
      profileVersion: numericProfileVersion,
      name: profile.name,
      durationDays: Number(profile.duration_days || 0),
      credits: Number(profile.credits || 0),
      cashAmount: Number(profile.cash_amount || 0),
      featureNavigationKeys,
      agentNavigationKeys: navigationKeys,
    },
  });
}

// PATCH /api/admin/cami - bind one unused membership card to one learner and
// push it to that learner's account notification center.
export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin?.userId) return NextResponse.json({ error: '无权限' }, { status: 403 });
  const authorization = await requireAdditionalCamiPermissions(admin.userId, ['members.view', 'packages.manage']);
  if (!authorization.ok) return authorization.response;
  const reauthToken = request.headers.get(ADMIN_CAMI_ASSIGNMENT_REAUTH_HEADER);
  if (!(await verifyAdminCamiAssignmentReauth(reauthToken, admin))) {
    return NextResponse.json({ error: '管理员密码验证已失效，请重新验证后推送', code: 'CAMI_ASSIGNMENT_REAUTH_REQUIRED' }, { status: 401 });
  }
  const body = await request.json() as Record<string, unknown>;
  const cardId = typeof body.cardId === 'string' ? body.cardId.trim() : '';
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const key = String(request.headers.get('idempotency-key') || body.idempotencyKey || '').trim();
  if (!cardId || !userId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(key)) {
    return NextResponse.json({ error: '卡密、学员或操作编号无效' }, { status: 400 });
  }

  const database = getSupabaseAdminClient();
  const { data: target, error: targetError } = await database
    .from('users')
    .select('username, display_name, phone, email, role, status, is_active, member_status, last_sign_in_at, allowed_categories')
    .eq('id', userId)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: '暂时无法读取学员' }, { status: 503 });
  if (!target || target.role === 'admin') return NextResponse.json({ error: '学员不存在' }, { status: 404 });
  if (getAccountGovernanceInfo(target).isFixture) {
    return NextResponse.json({ error: '测试/验收账号禁止接收正式会员卡密' }, { status: 400 });
  }

  const [cardResult, pendingCardsResult, currentPackageResult] = await Promise.all([
    database
      .from('cami_codes')
      .select('id,plan_name,duration_days,is_used,assigned_to,profile_key,profile_version,feature_navigation_keys,allowed_categories')
      .eq('id', cardId)
      .maybeSingle(),
    database
      .from('cami_codes')
      .select('id,plan_name,assigned_at')
      .eq('assigned_to', userId)
      .eq('is_used', false)
      .neq('id', cardId)
      .limit(1),
    database
      .from('member_package_assignments')
      .select('id,package_name,membership_status,profile_key,profile_version,duration_days,created_at')
      .eq('user_id', userId)
      .eq('membership_status', 'active')
      .order('created_at', { ascending: false })
      .limit(1),
  ]);
  if (cardResult.error || pendingCardsResult.error || currentPackageResult.error) {
    return NextResponse.json({ error: '暂时无法核对激活卡与学员套餐状态' }, { status: 503 });
  }
  const card = cardResult.data;
  if (!card || card.is_used) return NextResponse.json({ error: card ? '激活卡已被兑换' : '激活卡不存在' }, { status: card ? 409 : 404 });
  if (!card.profile_key || !Number.isInteger(card.profile_version) || !Array.isArray(card.feature_navigation_keys)) {
    return NextResponse.json({
      error: '这是一张未冻结套餐权限的历史卡，不能通过新链路推送；请生成绑定正式套餐模板的新激活卡',
      code: 'CAMI_ASSIGNMENT_PROFILE_SNAPSHOT_REQUIRED',
    }, { status: 409 });
  }
  const pendingCards = pendingCardsResult.data || [];
  if (pendingCards && pendingCards.length > 0) {
    return NextResponse.json({
      error: `该学员已有待兑换激活卡“${pendingCards[0].plan_name || pendingCards[0].id}”，请先兑换或处理原卡，避免重复推送`,
      code: 'CAMI_ASSIGNMENT_PENDING_EXISTS',
    }, { status: 409 });
  }
  const currentPackage = currentPackageResult.data?.[0] || null;
  if (target.member_status === 'active'
    && Number(card.duration_days || 0) === 0
    && currentPackage?.profile_key === card.profile_key
    && Number(currentPackage.profile_version || 0) === Number(card.profile_version || 0)) {
    return NextResponse.json({
      error: `该学员已经开通同一版本的“${card.plan_name || currentPackage.package_name || '会员套餐'}”，本次已阻止重复发卡；如需变更，请选择其他套餐或新版本`,
      code: 'CAMI_ASSIGNMENT_PACKAGE_ALREADY_ACTIVE',
    }, { status: 409 });
  }

  const { data, error } = await database.rpc('assign_cami_to_user_atomic', {
    p_admin_id: admin.userId,
    p_cami_id: cardId,
    p_user_id: userId,
    p_idempotency_key: key,
  });
  if (error) {
    const missing = ['PGRST202', '42883', '42P01', '42703'].includes(String(error.code || ''));
    return NextResponse.json({
      error: missing ? '卡密绑定迁移尚未就绪，本次未推送' : '卡密推送结果尚未确认，请保留原操作编号核对',
      code: missing ? 'CAMI_ASSIGNMENT_MIGRATION_NOT_READY' : 'CAMI_ASSIGNMENT_OUTCOME_UNKNOWN',
    }, { status: 503 });
  }
  const receipt = data as Record<string, unknown> | null;
  if (receipt?.success !== true) {
    const code = typeof receipt?.code === 'string' ? receipt.code : 'CAMI_ASSIGNMENT_FAILED';
    const messages: Record<string, string> = {
      CAMI_ASSIGNMENT_CARD_NOT_FOUND: '卡密不存在',
      CAMI_ASSIGNMENT_CARD_USED: '卡密已被使用',
      CAMI_ASSIGNMENT_CARD_EXPIRED: '卡密已过期',
      CAMI_ASSIGNMENT_ALREADY_BOUND: '卡密已绑定其他学员',
      CAMI_ASSIGNMENT_USER_INVALID: '目标学员无效',
      CAMI_ASSIGNMENT_PROFILE_SNAPSHOT_REQUIRED: '这张历史卡没有完整套餐权限快照，请生成新激活卡',
      CAMI_ASSIGNMENT_PENDING_EXISTS: '该学员已有待兑换激活卡，请先处理原卡',
      CAMI_ASSIGNMENT_PACKAGE_ALREADY_ACTIVE: '该学员已开通同一版本套餐，本次已阻止重复发卡',
    };
    return NextResponse.json({ error: messages[code] || '卡密推送未通过业务校验', code }, { status: code.includes('BOUND') || code.includes('USED') ? 409 : 400 });
  }
  return NextResponse.json({ success: true, idempotencyKey: key, assignment: receipt });
}

// DELETE /api/admin/cami - 删除卡密
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '无权限' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get('batch_id');

  if (batchId) {
    // 删除整批未使用的卡密
    const { error } = await camiRestApi(
      'DELETE',
      `cami_codes?batch_id=eq.${encodeURIComponent(batchId)}&is_used=eq.false&assigned_to=is.null`
    );
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: '请指定 batch_id' }, { status: 400 });
}
