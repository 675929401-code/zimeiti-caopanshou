import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-middleware';
import { calculateVoiceCost, getModelPricing } from '@/lib/vs/pricing';
import { getBillingConfig } from '@/lib/billing';

export async function GET(request: NextRequest) {
  const response = await withAuth(request, async (user) => {
    try {
      const billing = await getBillingConfig();
      const quote = calculateVoiceCost(1, 'seed-audio-1.0', billing.creditsPerYuan, 120);
      const price = getModelPricing('seed-audio-1.0');
      if (!quote || !price) throw new Error('VOICE_IMITATION_PRICE_UNAVAILABLE');
      return NextResponse.json({
        success: true,
        data: {
          reserveCredits: quote.creditsToCharge,
          maxSeconds: 120,
          unitPrice: Math.round(price.costPrice * (1 + price.profitMargin / 100) * 100) / 100,
          unit: '分钟',
          settlement: 'actual_seconds',
          creditsPerYuan: billing.creditsPerYuan,
        },
      });
    } catch {
      return NextResponse.json({ success: false, message: '音色模仿价格暂时无法读取' }, { status: 503 });
    }
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
