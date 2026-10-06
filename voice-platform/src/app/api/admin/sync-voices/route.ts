import { NextRequest } from 'next/server';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';

const ACCESS_KEY = process.env.VOLC_ACCESS_KEY?.trim() ?? '';
const SECRET_KEY = process.env.VOLC_SECRET_KEY?.trim() ?? '';
const HOST = 'open.volcengineapi.com';
const QUERY = 'Action=ListSpeakers&Version=2025-05-20';
const REGION = 'cn-beijing';
const SERVICE = 'speech_saas_prod';

function sha256Hex(message: string) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}
function hmac(key: Buffer | string, data: string) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

async function listSpeakers(resourceId: string, page: number, limit: number) {
  const now = new Date();
  const dateTime = now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
  const date = dateTime.slice(0, 8);

  const bodyStr = JSON.stringify({ ResourceIDs: [resourceId], Page: page, Limit: limit });
  const bodyHash = sha256Hex(bodyStr);

  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-content-sha256:${bodyHash}\nx-date:${dateTime}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';

  const canonicalRequest = ['POST', '/', QUERY, canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const credentialScope = `${date}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', dateTime, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(SECRET_KEY, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${HOST}/?${QUERY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Host': HOST,
      'X-Date': dateTime,
      'X-Content-Sha256': bodyHash,
      'Authorization': authorization,
    },
    body: bodyStr,
  });

  const data = await response.json();
  if (data.ResponseMetadata?.Error) {
    throw new Error(`ListSpeakers错误: ${data.ResponseMetadata.Error.Message}`);
  }
  return data.Result;
}

export async function POST(request: NextRequest) {
  try {
    const beforeCount = await prisma.voice.count();
    const allSpeakers: any[] = [];

    // 获取 seed-tts-2.0 全量音色
    let page = 1;
    let total = 0;
    do {
      const result = await listSpeakers('seed-tts-2.0', page, 100);
      if (!result?.Speakers?.length) break;
      total = result.Total || 0;
      allSpeakers.push(...result.Speakers);
      page++;
      await new Promise(r => setTimeout(r, 300));
    } while (allSpeakers.length < total && page <= 50);

    // 同步到数据库
    let upserted = 0, skipped = 0;
    for (const speaker of allSpeakers) {
      const voiceType = speaker.VoiceType || '';
      if (!voiceType) { skipped++; continue; }

      let category = '通用场景';
      let tags: string[] = [];
      if (speaker.Categories?.length > 0) {
        const cats = speaker.Categories.flatMap((c: any) => c.Categories || []);
        if (cats.length > 0) { category = cats[0]; tags = cats; }
      }
      if (speaker.NormalLabels) tags.push(...speaker.NormalLabels);
      if (speaker.SpecialLabels) tags.push(...speaker.SpecialLabels);

      let language = 'zh-cn';
      if (speaker.Languages?.length > 0) language = speaker.Languages[0].Language || 'zh-cn';

      // 只保留中文/双语（zh/zh-cn）音色，纯外语音色不同步
      if (language !== 'zh' && language !== 'zh-cn') { skipped++; continue; }

      let gender = null;
      if (speaker.Gender === '女') gender = 'female';
      else if (speaker.Gender === '男') gender = 'male';

      let type = 'official';
      if (voiceType.startsWith('ICL_') || voiceType.startsWith('icl_')) type = 'icl';

      try {
        await prisma.voice.upsert({
          where: { speakerId: voiceType },
          create: {
            speakerId: voiceType,
            name: speaker.Name || voiceType,
            description: speaker.Description || '',
            type, category,
            tags: JSON.stringify([...new Set(tags)]),
            language, gender,
            avatar: speaker.Avatar || null,
            isActive: true,
          },
          update: {
            name: speaker.Name || voiceType,
            description: speaker.Description || '',
            category,
            tags: JSON.stringify([...new Set(tags)]),
            language, gender,
            avatar: speaker.Avatar || null,
          },
        });
        upserted++;
      } catch {
        skipped++;
      }
    }

    const afterCount = await prisma.voice.count();

    return successResponse({
      beforeCount,
      afterCount,
      fetchedFromApi: allSpeakers.length,
      upserted,
      skipped,
      message: `同步完成：从API获取${allSpeakers.length}个音色，更新${upserted}个，数据库总计${afterCount}个`,
    }, '音色同步成功');
  } catch (error: any) {
    return errorResponse(`同步失败: ${error.message}`, 'SYNC_ERROR', 500);
  }
}
