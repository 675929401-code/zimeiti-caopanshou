import { NextRequest } from 'next/server';
import { getResourceIdBySpeaker, getDefaultModelBySpeaker } from '@/lib/voices-data';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

// 试听固定 demo 文本（按新分类体系）
const PREVIEW_TEXTS: Record<string, string> = {
  '热门推荐': '大家好，欢迎来到智音工坊！今天给大家带来一款超好用的AI配音工具，快来试试吧！',
  '影视解说': '故事的转折往往出人意料。在这个看似平静的小镇上，一场暗流涌动的风暴正在酝酿。',
  '角色动漫': '哼，凡人，你终于来了！本姑娘已经等你很久了，还不快快报上名来！',
  '情感治愈': '你知道吗，有时候生活就是这样，给你关上一扇门的同时，也会为你打开一扇窗。',
  '短视频配音': '哈喽大家好呀！今天给大家分享一个超实用的小技巧，记得点赞收藏哦！',
  '商业播报': '您好，欢迎致电智音客服中心。我是您的专属客服顾问，很高兴为您服务。',
  '__default__': '你好，我是智音工坊的语音助手，希望能为你提供专业的配音服务。',
};

// 直接调用火山 unidirectional 接口（不走 synthesizeSpeech 避免流式响应解析问题）
async function previewSynthesize(speakerId: string, text: string, resourceId: string) {
  const config = await prisma.apiConfig.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  const apiKey = config?.apiKey || process.env.VOLCENGINE_API_KEY_1 || '';
  const apiBase = process.env.VOLCENGINE_API_BASE || 'https://openspeech.bytedance.com';
  const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // 根据音色类型自动选择正确的 model（uranus 用 standard，saturn/ICL 用 expressive）
  const model = getDefaultModelBySpeaker(speakerId);

  const body = {
    req_params: {
      text,
      speaker: speakerId,
      model,
      audio_params: {
        format: 'mp3',
        sample_rate: 16000,
        speech_rate: 0,
        loudness_rate: 0,
      },
      post_process: { pitch: 0 },
    },
  };

  const response = await fetch(`${apiBase}/api/v3/tts/unidirectional`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`火山API HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  // 调试：记录响应类型
  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();

  // 尝试 JSON 解析
  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    // 非 JSON，可能是 NDJSON 流
  }

  if (data) {
    // 错误检查
    if (data.code !== undefined && data.code !== 20000000 && data.code !== 0) {
      const errMsg = data.message || data.msg || '未知错误';
      throw new Error(`火山API错误: ${errMsg} (code: ${data.code}, speaker: ${speakerId}, model: ${model}, resource: ${resourceId})`);
    }

    // 情况1: data.url 直接返回 URL
    const directUrl = data.url || data.data?.url;
    if (directUrl && !directUrl.startsWith('SUQ') && directUrl.startsWith('http')) {
      return { audioUrl: directUrl, duration: data.duration || data.data?.duration || 0 };
    }

    // 情况2: data.data 是 base64 音频（火山 unidirectional 实际返回格式）
    const audioBase64 = typeof data.data === 'string' ? data.data : '';
    if (audioBase64 && audioBase64.length > 100) {
      // base64 → data URL
      const dataUrl = `data:audio/mp3;base64,${audioBase64}`;
      return { audioUrl: dataUrl, duration: data.duration || 0 };
    }
  }

  // 情况3: NDJSON 流式响应，按行解析
  const lines = rawText.split('\n').filter(Boolean);
  let audioUrl = '';
  let duration = 0;
  let combinedBase64 = '';

  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.url && evt.url.startsWith('http')) audioUrl = evt.url;
      if (evt.duration) duration = evt.duration;
      // 流式分片音频数据
      if (typeof evt.data === 'string' && evt.data.length > 0) {
        combinedBase64 += evt.data;
      }
      if (evt.code && evt.code !== 20000000 && evt.code !== 0) {
        throw new Error(`火山合成错误: ${evt.message || ''} (code: ${evt.code})`);
      }
    } catch (e) {
      // 跳过非 JSON 行
    }
  }

  if (audioUrl) return { audioUrl, duration };
  if (combinedBase64) {
    return { audioUrl: `data:audio/mp3;base64,${combinedBase64}`, duration };
  }

  throw new Error(`火山API未返回有效音频数据。响应前300字符: ${rawText.slice(0, 300)}`);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { speakerId, category } = body;

    if (!speakerId) {
      return errorResponse('speakerId 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    // 根据音色分类选择合适的预览文本
    const text = PREVIEW_TEXTS[category] || PREVIEW_TEXTS.__default__;
    const resourceId = getResourceIdBySpeaker(speakerId);

    const result = await previewSynthesize(speakerId, text, resourceId);

    return successResponse({
      audioUrl: result.audioUrl,
      duration: result.duration,
      text,
      speakerId,
    }, '试听合成成功');
  } catch (error: any) {
    return errorResponse(error.message || '试听合成失败', 'PREVIEW_ERROR', 500);
  }
}
