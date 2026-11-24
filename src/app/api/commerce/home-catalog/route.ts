import { NextResponse } from 'next/server';
import { primePublishedHomeCatalog } from '@/commerce/server/home-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const catalog = await primePublishedHomeCatalog();
    return NextResponse.json({ ok: true, catalog }, { headers: { 'Cache-Control': 'public, max-age=15' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : '读取失败' }, { status: 503 });
  }
}
