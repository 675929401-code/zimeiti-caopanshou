import { readVoiceCatalog } from '@/lib/voice-studio/catalog';
import { NextRequest, NextResponse } from 'next/server';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getDefaultModelBySpeaker } from '@/lib/vs/voices-data';
import { calculateVoiceCost, getModelPricing } from '@/lib/vs/pricing';
import { getBillingConfig } from '@/lib/billing';
import { inspectVolcanoVoiceProviderConfig } from '@/lib/server/voice-provider-config';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const db = getSupabaseClient();
    const [provider, wallet, personal, training, licenses, billing] = await Promise.all([
      inspectVolcanoVoiceProviderConfig(),
      db.from('users').select('credits').eq('id', auth.user.userId).single(),
      db.from('user_voices').select('id,voice_name,speaker_id,voice_type').eq('user_id', auth.user.userId).eq('is_active', true),
      db.from('voice_training_authorization_jobs').select('voice_id,provider_speaker_id').eq('user_id', auth.user.userId).eq('status', 'completed'),
      db.from('voice_clone_licenses').select('max_trainings,used_trainings,status').eq('user_id', auth.user.userId).eq('status', 'active'),
      getBillingConfig(),
    ]);
    if (wallet.error || personal.error || training.error || licenses.error) throw new Error('catalog unavailable');
    const voices = provider.configured && getModelPricing('seed-tts-2.0') ? readVoiceCatalog().map(voice => ({
      id: voice.speakerId, name: voice.name, description: voice.description, gender:voice.gender, group: '常用音色',
      speakerId: voice.speakerId, engine: 'volcano', model: getDefaultModelBySpeaker(voice.speakerId),
      billingModel: 'seed-tts-2.0', resourceId: 'seed-tts-2.0',
    })) : [];
    const ownedReady = new Map((training.data || []).map((row: { voice_id: string | number; provider_speaker_id: string }) => [String(row.voice_id), row.provider_speaker_id]));
    if (provider.configured && getModelPricing('seed-icl-2.0')) for (const voice of personal.data || []) {
      if (ownedReady.get(String(voice.id)) !== voice.speaker_id) continue;
      voices.push({ id: String(voice.id), name: voice.voice_name, gender:'', description: '智音工坊中已完成训练的个人音色', group: '我的音色',
        speakerId: voice.speaker_id, engine: 'volcano', model: 'seed-icl-2.0', billingModel: 'seed-icl-2.0', resourceId: 'seed-icl-2.0' });
    }
    const chars = Math.min(5000, Math.max(0, Number(request.nextUrl.searchParams.get('chars')) || 0));
    const selected = voices.find(voice => voice.id === request.nextUrl.searchParams.get('voiceId'));
    const quote = selected && chars ? calculateVoiceCost(chars, selected.billingModel, billing.creditsPerYuan) : null;
    const remaining = (licenses.data || []).reduce((sum: number, row: { max_trainings: number; used_trainings: number }) => sum + Math.max(0, Number(row.max_trainings) - Number(row.used_trainings)), 0);
    return NextResponse.json({ voices, credits: Number(wallet.data?.credits || 0), cloneRemaining: remaining,
      cloneSynthesisAvailable: Boolean(provider.configured && getModelPricing('seed-icl-2.0')),
      quote: quote ? { credits: quote.creditsToCharge, unit: quote.pricing.unit, chars } : null,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return NextResponse.json({ error: '配音配置暂时无法读取，请稍后重试' }, { status: 503 }); }
}
