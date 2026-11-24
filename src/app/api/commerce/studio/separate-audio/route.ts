import { requireIdentity, sameOrigin } from '@/commerce/server/auth';
import { authorizeCurrentCommerceIdentity } from '@/commerce/server/main-account-access';
import { separateAudio } from '@/commerce/server/separate-audio';
import { errorResponse, json } from '@/commerce/server/http';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = requireIdentity(request);
    await authorizeCurrentCommerceIdentity(user);
    const { assetId, format = 'mp4' } = await request.json();
    if (format !== 'mp4' && format !== 'mkv') return json({error:'请选择 MP4 或 MKV 视频格式'},400);
    return json(await separateAudio(user.id, String(assetId || ''), format));
  } catch (error) { return errorResponse(error); }
}