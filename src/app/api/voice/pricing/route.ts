// 获取语音模型定价
// GET /api/voice/pricing
import { NextResponse } from 'next/server';
import { getAllModelPricing, VoicePricingCatalogError } from '@/lib/vs/pricing';

export async function GET() {
  try {
    const pricing = getAllModelPricing();
    if (pricing.length === 0) throw new VoicePricingCatalogError();
    return NextResponse.json({
      success: true,
      data: pricing.map(p => ({
        modelId: p.modelId,
        name: p.name,
        unit: p.unit,
        priceReady: Number.isFinite(p.costPrice) && p.costPrice > 0 && Number.isFinite(p.profitMargin) && p.profitMargin > -100,
      })),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error: unknown) {
    const unavailable = error instanceof VoicePricingCatalogError;
    return NextResponse.json({
      success: false,
      message: '语音模型价格暂时无法读取',
      code: unavailable ? error.code : 'VOICE_PRICING_CATALOG_UNAVAILABLE',
    }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
