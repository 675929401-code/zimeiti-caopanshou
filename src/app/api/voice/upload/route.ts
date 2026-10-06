import { NextRequest, NextResponse } from 'next/server';

import { withAuth } from '@/lib/api-middleware';
import {
  MAX_CUSTOM_VOICE_FILE_BYTES,
  deleteOwnedCustomVoice,
  listOwnedCustomVoices,
  registerCustomVoiceAsset,
  renameOwnedCustomVoice,
  toPublicCustomVoice,
} from '@/lib/server/custom-voice-assets';

export const runtime = 'nodejs';

function uploadFailure(error: unknown): { status: number; message: string } {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'CUSTOM_VOICE_FILE_SIZE_INVALID') return { status: 413, message: '单个文件不能超过 15MB' };
  if (code === 'CUSTOM_VOICE_QUOTA_EXCEEDED') return { status: 413, message: '存储空间不足，每个用户上限 5GB' };
  if (code === 'CUSTOM_VOICE_NAME_REQUIRED') return { status: 400, message: '音色名称不能为空' };
  if (code === 'CUSTOM_VOICE_DURATION_INVALID') return { status: 422, message: '参考音频真实时长必须在 14–30 秒之间' };
  if (code === 'AUDIO_SIGNATURE_UNRECOGNIZED') return { status: 400, message: '文件内容不是受支持的真实音频容器' };
  if (code === 'AUDIO_EXTENSION_SIGNATURE_MISMATCH') return { status: 400, message: '文件扩展名与真实音频容器不一致' };
  if (code === 'AUDIO_MIME_SIGNATURE_MISMATCH') return { status: 400, message: '声明的音频 MIME 类型与文件内容不一致' };
  return { status: 500, message: '上传失败' };
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user) => {
    try {

      const formData = await request.formData();
      const file = formData.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ error: '请选择音频文件' }, { status: 400 });
      }
      if (file.size === 0 || file.size > MAX_CUSTOM_VOICE_FILE_BYTES) {
        return NextResponse.json({ error: '单个文件必须大于 0 且不能超过 15MB' }, { status: 413 });
      }

      const genderValue = String(formData.get('gender') || 'female');
      if (genderValue !== 'female' && genderValue !== 'male') {
        return NextResponse.json({ error: '音色性别参数无效' }, { status: 400 });
      }
      const name = String(
        formData.get('name') || file.name.replace(/\.[^/.]+$/, '') || '未命名音色',
      ).trim().slice(0, 80);
      const bytes = Buffer.from(await file.arrayBuffer());
      const voice = await registerCustomVoiceAsset({
        bytes,
        originalFileName: file.name,
        declaredMimeType: file.type,
        name,
        userId: user.id,
        userName: user.displayName || user.email || '用户',
        gender: genderValue,
        source: 'upload',
      });
    return NextResponse.json({ success: true, voice: toPublicCustomVoice(voice) });
  } catch (error) {
    const failure = uploadFailure(error);
    if (failure.status >= 500) console.error('[VoiceUpload] Upload failed:', error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  });
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user) => {
    try {
      const voices = await listOwnedCustomVoices(user.id);
      return NextResponse.json({ success: true, voices: voices.map(toPublicCustomVoice) });
    } catch (error) {
      console.error('[VoiceUpload] List failed:', error);
      return NextResponse.json({ error: '获取失败' }, { status: 500 });
    }
  });
}

export async function PUT(request: NextRequest) {
  return withAuth(request, async (user) => {
    try {
      const body = await request.json().catch(() => ({})) as { id?: unknown; name?: unknown };
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!id) return NextResponse.json({ error: '缺少音色ID' }, { status: 400 });
      if (!name) return NextResponse.json({ error: '音色名称不能为空' }, { status: 400 });
      const voice = await renameOwnedCustomVoice(user.id, id, name);
      if (!voice) return NextResponse.json({ error: '音色不存在或无权限' }, { status: 404 });
      return NextResponse.json({ success: true, voice: toPublicCustomVoice(voice) });
    } catch (error) {
      console.error('[VoiceUpload] Rename failed:', error);
      return NextResponse.json({ error: '重命名失败' }, { status: 500 });
    }
  });
}

export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user) => {
    try {
      const body = await request.json().catch(() => ({})) as { id?: unknown };
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return NextResponse.json({ error: '缺少音色ID' }, { status: 400 });
      const removed = await deleteOwnedCustomVoice(user.id, id);
      if (!removed) return NextResponse.json({ error: '音色不存在或无权限' }, { status: 404 });
      return NextResponse.json({ success: true });
    } catch (error) {
      console.error('[VoiceUpload] Delete failed:', error);
      return NextResponse.json({ error: '删除失败' }, { status: 500 });
    }
  });
}
