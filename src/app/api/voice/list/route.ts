import { EMOTIONAL_VOICE_IDS } from '@/lib/vs/voice-curation';
import { NextRequest, NextResponse } from 'next/server';
import { readVoiceCatalog } from '@/lib/voice-studio/catalog';
export const dynamic='force-dynamic';
export const revalidate=0;

export async function GET(req: NextRequest) {
  try {
  const { searchParams } = new URL(req.url);
  const keyword = searchParams.get('keyword') || '';
  const engine = searchParams.get('engine') || '';
  const category = searchParams.get('category') || '';
  const gender = searchParams.get('gender') || '';
  const type = searchParams.get('type') || '';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1);
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '60') || 60));

  let list = readVoiceCatalog().map(({adminId,...voice})=>voice);
  const collection=searchParams.get('collection');
  if(collection==='best')list=list.filter(v=>v.speakerId?.endsWith('_uranus_bigtts'));
  if(collection==='emotional')list=list.filter(v=>EMOTIONAL_VOICE_IDS.includes(v.speakerId||''));
  if (keyword) list = list.filter(v => v.name.toLowerCase().includes(keyword.toLowerCase()) || v.speakerId?.toLowerCase().includes(keyword.toLowerCase()) || v.description.includes(keyword) || v.styleTags.some((t: string) => t.includes(keyword)));
  if (engine) list = list.filter(v => v.engine === engine);
  if (category) list = list.filter(v => v.styleTags.some((t: string) => t.includes(category)) || ((v as { category?: string }).category && (v as { category?: string }).category!.includes(category)));
  if (gender) list = list.filter(v => v.gender === gender);
  if (type) list = list.filter(v => (v as { type?: string }).type === type || v.engine === type);

  const total = list.length;
  const start = (page - 1) * limit;
  const paged = list.slice(start, start + limit);

  return NextResponse.json({
    success: true,
    data: {
      voices: paged,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    message: `共 ${total} 个声音`,
  }, {headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({success:false,message:'音色目录暂时不可用，请稍后重试。'},{status:503}); }
}
