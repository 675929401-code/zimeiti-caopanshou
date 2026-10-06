import { NextRequest } from 'next/server';
import { handleDigitalHumanProxyUpload } from '@/lib/digital-human-upload-proxy';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  return handleDigitalHumanProxyUpload(request);
}
