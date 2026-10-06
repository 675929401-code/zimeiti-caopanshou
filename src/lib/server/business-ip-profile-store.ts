import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BUSINESS_IP_CONSULTATION_AGENT_ID,
  buildBusinessIpProfilePromptContext,
  normalizeBusinessIpProfileData,
  normalizeBusinessIpProfileStatus,
  type BusinessIpMemberProfile,
} from '@/lib/business-ip/business-profile';

type ProfileRow = {
  id: string;
  name: string;
  business_data: string;
  status: string;
  version: number;
  last_used_at: string;
  created_at: string;
  updated_at: string;
};

function toProfile(row: ProfileRow): BusinessIpMemberProfile {
  return {
    ...row,
    business_data: normalizeBusinessIpProfileData(row.business_data),
    status: normalizeBusinessIpProfileStatus(row.status),
    version: Math.max(1, Number(row.version) || 1),
  };
}

export async function loadActiveBusinessIpProfile(
  client: SupabaseClient,
  userId: string,
): Promise<BusinessIpMemberProfile | null> {
  const { data, error } = await client
    .from('business_ip_member_profiles')
    .select('id,name,business_data,status,version,last_used_at,created_at,updated_at')
    .eq('user_id', userId)
    .order('last_used_at', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toProfile(data as ProfileRow) : null;
}

export async function loadConversationBusinessIpProfile(
  client: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<BusinessIpMemberProfile | null> {
  const { data: binding, error: bindingError } = await client
    .from('business_ip_conversation_profiles')
    .select('profile_id')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (bindingError) throw bindingError;
  const profileId = typeof binding?.profile_id === 'string' ? binding.profile_id : '';
  if (!profileId) return null;
  const { data, error } = await client
    .from('business_ip_member_profiles')
    .select('id,name,business_data,status,version,last_used_at,created_at,updated_at')
    .eq('id', profileId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? toProfile(data as ProfileRow) : null;
}

export async function buildBusinessIpConsultationProfileContext(input: {
  client: SupabaseClient;
  userId: string;
  agentId?: string | null;
  conversationId?: string | null;
}): Promise<string> {
  if (input.agentId !== BUSINESS_IP_CONSULTATION_AGENT_ID) return '';
  try {
    const conversationId = typeof input.conversationId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(input.conversationId)
      ? input.conversationId
      : '';
    return buildBusinessIpProfilePromptContext(conversationId
      ? await loadConversationBusinessIpProfile(input.client, input.userId, conversationId)
      : await loadActiveBusinessIpProfile(input.client, input.userId));
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
    console.error(`[BIP_PROFILE] active profile unavailable${code ? ` code=${code}` : ''}`);
    return buildBusinessIpProfilePromptContext(null);
  }
}
