import { requireIdentity, sameOrigin } from '../../../../commerce/server/auth';
import { authorizeCurrentCommerceIdentity } from '../../../../commerce/server/main-account-access';
import { createCommerceQuote, readCommerceQuote } from '../../../../commerce/server/quotes';
import { errorResponse, json } from '../../../../commerce/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = requireIdentity(request);
    const id = new URL(request.url).searchParams.get('id') || '';
    const quote = readCommerceQuote(user.id, id);
    if (!quote) return json({ error: '报价不存在' }, 404);
    return json({ quote });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = requireIdentity(request);
    await authorizeCurrentCommerceIdentity(user);
    const quote = await createCommerceQuote(user.id, await request.json());
    return json({ quote }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
