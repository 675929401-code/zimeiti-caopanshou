import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth, type ApiHandler } from '@/lib/api-middleware';
import {
  BUSINESS_IP_PROFILE_MAX_DATA,
  BUSINESS_IP_PROFILE_MAX_NAME,
  inferBusinessIpProfileStatus,
  normalizeBusinessIpProfileName,
  sanitizeBusinessIpProfileData,
} from '@/lib/business-ip/business-profile';
import { checkBipInput } from '@/lib/business-ip/guard';

type AppSupabaseClient = Parameters<ApiHandler>[1];
type ProfileRow = {
  id: string;
  user_id: string;
  name: string;
  business_data: string;
  status: string;
  version: number;
  last_used_at: string;
  created_at: string;
  updated_at: string;
};
type ProfileDatabase = {
  public: {
    Tables: {
      business_ip_member_profiles: {
        Row: ProfileRow;
        Insert: Partial<ProfileRow> & Pick<ProfileRow, 'user_id' | 'name' | 'business_data'>;
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      business_ip_conversation_profiles: {
        Row: { id: string; user_id: string; conversation_id: string; profile_id: string; bound_profile_version: number; created_at: string; updated_at: string };
        Insert: { user_id: string; conversation_id: string; profile_id: string; bound_profile_version: number; updated_at?: string };
        Update: { profile_id?: string; bound_profile_version?: number; updated_at?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
type ProfileClient = SupabaseClient<ProfileDatabase>;

function asProfileClient(client: AppSupabaseClient): ProfileClient {
  return client as unknown as ProfileClient;
}

const HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };
const SELECT = 'id,name,business_data,status,version,last_used_at,created_at,updated_at';
const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

function conversationIdFrom(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return CONVERSATION_ID_PATTERN.test(id) ? id : '';
}

async function bindProfileToConversation(db: ProfileClient, input: {
  userId: string;
  conversationId: string;
  profileId: string;
  profileVersion: number;
}) {
  if (!input.conversationId) return null;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('business_ip_conversation_profiles')
    .upsert({
      user_id: input.userId,
      conversation_id: input.conversationId,
      profile_id: input.profileId,
      bound_profile_version: Math.max(1, input.profileVersion),
      updated_at: now,
    }, { onConflict: 'user_id,conversation_id' })
    .select('profile_id')
    .single();
  if (error) throw error;
  return data?.profile_id || null;
}

function unavailable(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  console.error(`[business-ip-profiles] unavailable${code ? ` code=${code}` : ''}`);
  return NextResponse.json(
    { error: '会员业务资料库暂时无法使用，本次仍可把资料直接发给小助理' },
    { status: 503, headers: HEADERS },
  );
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, client) => {
    const db = asProfileClient(client);
    const conversationId = conversationIdFrom(new URL(request.url).searchParams.get('conversation_id'));
    const [{ data, error }, bindingResult] = await Promise.all([
      db
      .from('business_ip_member_profiles')
      .select(SELECT)
      .eq('user_id', user.id)
      .order('last_used_at', { ascending: false })
      .order('updated_at', { ascending: false }),
      conversationId
        ? db.from('business_ip_conversation_profiles').select('profile_id').eq('user_id', user.id).eq('conversation_id', conversationId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (error) return unavailable(error);
    if (bindingResult.error) return unavailable(bindingResult.error);
    const boundProfileId = bindingResult.data?.profile_id || null;
    return NextResponse.json({
      profiles: data || [],
      active_profile_id: boundProfileId || data?.[0]?.id || null,
      bound_profile_id: boundProfileId,
    }, { headers: HEADERS });
  });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user, client) => {
    const body = await request.json().catch(() => null);
    const conversationId = conversationIdFrom(body?.conversation_id);
    const name = normalizeBusinessIpProfileName(body?.name);
    const businessData = sanitizeBusinessIpProfileData(body?.business_data);
    const status = inferBusinessIpProfileStatus(businessData);
    if (!name || name.length > BUSINESS_IP_PROFILE_MAX_NAME) {
      return NextResponse.json({ error: '请填写这项业务的名称' }, { status: 400, headers: HEADERS });
    }
    if (!businessData || businessData.length > BUSINESS_IP_PROFILE_MAX_DATA) {
      return NextResponse.json({ error: '请填写业务资料，最多六万字' }, { status: 400, headers: HEADERS });
    }
    if (checkBipInput([{ role: 'user', content: businessData }])) {
      return NextResponse.json({ error: '业务资料中含有要求泄露或改写平台规则的内容，请删除后再保存' }, { status: 400, headers: HEADERS });
    }
    const now = new Date().toISOString();
    const { data, error } = await asProfileClient(client)
      .from('business_ip_member_profiles')
      .insert({ user_id: user.id, name, business_data: businessData, status, version: 1, last_used_at: now, updated_at: now })
      .select(SELECT)
      .single();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: '这项业务已存在，请选择后更新' }, { status: 409, headers: HEADERS });
      }
      return unavailable(error);
    }
    try {
      await bindProfileToConversation(asProfileClient(client), { userId: user.id, conversationId, profileId: data.id, profileVersion: data.version });
    } catch (bindingError) { return unavailable(bindingError); }
    return NextResponse.json({ profile: data, active_profile_id: data.id, bound_profile_id: conversationId ? data.id : null }, { status: 201, headers: HEADERS });
  });
}

export async function PUT(request: NextRequest) {
  return withAuth(request, async (user, client) => {
    const db = asProfileClient(client);
    const body = await request.json().catch(() => null);
    const conversationId = conversationIdFrom(body?.conversation_id);
    if (body?.unbind === true) {
      if (!conversationId) return NextResponse.json({ error: '当前顾客对话编号无效' }, { status: 400, headers: HEADERS });
      const { error } = await db.from('business_ip_conversation_profiles').delete().eq('user_id', user.id).eq('conversation_id', conversationId);
      if (error) return unavailable(error);
      return NextResponse.json({ success: true, bound_profile_id: null }, { headers: HEADERS });
    }
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) return NextResponse.json({ error: '请选择业务档案' }, { status: 400, headers: HEADERS });

    const { data: existing, error: readError } = await db
      .from('business_ip_member_profiles')
      .select('id,name,business_data,status,version,last_used_at,created_at,updated_at')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (readError) return unavailable(readError);
    if (!existing) return NextResponse.json({ error: '业务档案不存在' }, { status: 404, headers: HEADERS });

    const activateOnly = body?.activate === true && body?.business_data === undefined && body?.name === undefined;
    const now = new Date().toISOString();
    const patch: Partial<ProfileRow> = { last_used_at: now };
    if (!activateOnly) {
      const name = normalizeBusinessIpProfileName(body?.name ?? existing.name);
      const businessData = sanitizeBusinessIpProfileData(body?.business_data ?? existing.business_data);
      if (!name) return NextResponse.json({ error: '请填写这项业务的名称' }, { status: 400, headers: HEADERS });
      if (!businessData) return NextResponse.json({ error: '请填写业务资料' }, { status: 400, headers: HEADERS });
      if (businessData.length > BUSINESS_IP_PROFILE_MAX_DATA) return NextResponse.json({ error: '业务资料超过六万字，请先整理精简后再保存' }, { status: 400, headers: HEADERS });
      if (checkBipInput([{ role: 'user', content: businessData }])) return NextResponse.json({ error: '业务资料中含有要求泄露或改写平台规则的内容，请删除后再保存' }, { status: 400, headers: HEADERS });
      const status = inferBusinessIpProfileStatus(businessData);
      const contentChanged = name !== existing.name
        || businessData !== existing.business_data
        || status !== existing.status;
      if (contentChanged) {
        patch.name = name;
        patch.business_data = businessData;
        patch.status = status;
        patch.version = Math.max(1, Number(existing.version) || 1) + 1;
        patch.updated_at = now;
      }
    }

    let updateQuery = db
      .from('business_ip_member_profiles')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id);
    if (!activateOnly) {
      const expectedVersion = Number(body?.expected_version);
      if (Number.isFinite(expectedVersion) && expectedVersion >= 1) {
        updateQuery = updateQuery.eq('version', Math.floor(expectedVersion));
      }
    }
    const { data, error } = await updateQuery
      .select(SELECT)
      .single();
    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: '这份业务资料已在其他窗口更新，请重新打开后再保存' }, { status: 409, headers: HEADERS });
      }
      if (error.code === '23505') {
        return NextResponse.json({ error: '这项业务名称已存在' }, { status: 409, headers: HEADERS });
      }
      return unavailable(error);
    }
    try {
      await bindProfileToConversation(db, { userId: user.id, conversationId, profileId: data.id, profileVersion: data.version });
    } catch (bindingError) { return unavailable(bindingError); }
    return NextResponse.json({ profile: data, active_profile_id: data.id, bound_profile_id: conversationId ? data.id : null }, { headers: HEADERS });
  });
}

export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user, client) => {
    const id = new URL(request.url).searchParams.get('id')?.trim() || '';
    if (!id) return NextResponse.json({ error: '请选择业务档案' }, { status: 400, headers: HEADERS });
    const { error } = await asProfileClient(client)
      .from('business_ip_member_profiles')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) return unavailable(error);
    return NextResponse.json({ success: true, id }, { headers: HEADERS });
  });
}
