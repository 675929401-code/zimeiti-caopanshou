/**
 * 火山引擎 ListSpeakers API - 手动V4签名（修正版）
 * 
 * 关键修复：body hash使用JSON序列化后的字符串
 */

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ACCESS_KEY = process.env.VOLC_ACCESS_KEY || '';
const SECRET_KEY = process.env.VOLC_SECRET_KEY || '';

const REGION = 'cn-beijing';
const SERVICE = 'speech_saas_prod';
const HOST = 'open.volcengineapi.com';

function sha256Hex(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

async function listSpeakers(resourceId, page = 1, limit = 100) {
  // 时间戳（UTC）
  const now = new Date();
  const dateTime = now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
  const date = dateTime.slice(0, 8);

  // 请求体（JSON字符串）
  const bodyStr = JSON.stringify({
    ResourceIDs: [resourceId],
    Page: page,
    Limit: limit,
  });
  const bodyHash = sha256Hex(bodyStr);

  // Canonical Query String
  const queryString = 'Action=ListSpeakers&Version=2025-05-20';

  // Canonical Headers
  const canonicalHeaders = 
    'content-type:application/json; charset=utf-8\n' +
    `host:${HOST}\n` +
    `x-content-sha256:${bodyHash}\n` +
    `x-date:${dateTime}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';

  // Canonical Request
  const canonicalRequest = [
    'POST',
    '/',
    queryString,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  // Credential Scope
  const credentialScope = `${date}/${REGION}/${SERVICE}/request`;

  // String to Sign
  const stringToSign = [
    'HMAC-SHA256',
    dateTime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Signing Key
  const kDate = hmac(SECRET_KEY, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');

  // Signature
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  // Authorization Header
  const authorization = `HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // 发送请求
  const url = `https://${HOST}/?${queryString}`;
  const response = await fetch(url, {
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

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`JSON parse error: ${text.slice(0, 300)}`);
  }

  if (data.ResponseMetadata?.Error) {
    throw new Error(`API Error: ${data.ResponseMetadata.Error.Message} (Code: ${data.ResponseMetadata.Error.Code})`);
  }

  return data.Result;
}

async function fetchAllSpeakers(resourceId) {
  const allSpeakers = [];
  let page = 1;
  const limit = 100;
  let total = 0;

  console.log(`\nFetching ${resourceId}...`);

  do {
    const result = await listSpeakers(resourceId, page, limit);
    
    if (!result || !result.Speakers || result.Speakers.length === 0) {
      console.log(`  Page ${page}: no data, stopping`);
      break;
    }

    total = result.Total || 0;
    allSpeakers.push(...result.Speakers.map(s => ({ ...s, _resourceId: resourceId })));
    console.log(`  Page ${page}: ${result.Speakers.length} speakers (total ${allSpeakers.length}/${total})`);

    page++;
    await new Promise(r => setTimeout(r, 300));
    if (page > 30) break;
  } while (allSpeakers.filter(s => s._resourceId === resourceId).length < total);

  return allSpeakers;
}

async function syncToDatabase(speakers) {
  let upserted = 0, skipped = 0;

  console.log(`\nSyncing ${speakers.length} voices to database...`);

  for (const speaker of speakers) {
    const voiceType = speaker.VoiceType || '';
    if (!voiceType) { skipped++; continue; }

    let category = '通用场景';
    let tags = [];
    if (speaker.Categories?.length > 0) {
      const cats = speaker.Categories.flatMap(c => c.Categories || []);
      if (cats.length > 0) { category = cats[0]; tags = cats; }
    }
    if (speaker.NormalLabels) tags.push(...speaker.NormalLabels);
    if (speaker.SpecialLabels) tags.push(...speaker.SpecialLabels);

    let language = 'zh-cn';
    if (speaker.Languages?.length > 0) {
      language = speaker.Languages[0].Language || 'zh-cn';
    }

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
          type,
          category,
          tags: JSON.stringify([...new Set(tags)]),
          language,
          gender,
          avatar: speaker.Avatar || null,
          isActive: true,
        },
        update: {
          name: speaker.Name || voiceType,
          description: speaker.Description || '',
          category,
          tags: JSON.stringify([...new Set(tags)]),
          language,
          gender,
          avatar: speaker.Avatar || null,
        },
      });
      upserted++;
    } catch (err) {
      console.log(`  Skip ${voiceType}: ${err.message.slice(0, 60)}`);
      skipped++;
    }
  }

  const dbCount = await prisma.voice.count();
  console.log(`\nDone! DB total: ${dbCount}, processed: ${upserted}, skipped: ${skipped}`);
}

async function main() {
  if (!ACCESS_KEY || !SECRET_KEY) {
    console.error('Missing AK/SK! Set VOLC_ACCESS_KEY and VOLC_SECRET_KEY');
    process.exit(1);
  }

  console.log('Volcano Engine ListSpeakers Sync (Fixed V4 Signer)');
  console.log(`AK: ${ACCESS_KEY.slice(0, 12)}...${ACCESS_KEY.slice(-4)}`);

  // Test single call first
  console.log('\n--- Testing single API call ---');
  try {
    const test = await listSpeakers('seed-tts-2.0', 1, 3);
    console.log(`Test OK! Total=${test.Total}, Speakers=${test.Speakers?.length}`);
    if (test.Speakers?.length > 0) {
      console.log(`  First: ${test.Speakers[0].VoiceType} | ${test.Speakers[0].Name}`);
    }
  } catch (err) {
    console.error(`Test FAILED: ${err.message}`);
    process.exit(1);
  }

  // Fetch all
  const ttsSpeakers = await fetchAllSpeakers('seed-tts-2.0');
  
  let iclSpeakers = [];
  try {
    iclSpeakers = await fetchAllSpeakers('seed-icl-2.0');
  } catch (err) {
    console.log(`\nICL fetch failed: ${err.message}`);
  }

  const allSpeakers = [...ttsSpeakers, ...iclSpeakers];
  console.log(`\nTotal fetched: ${allSpeakers.length} speakers`);

  // Preview
  console.log('\nPreview (first 10):');
  allSpeakers.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i+1}. ${s.VoiceType} | ${s.Name} | ${s.Gender} | ${s._resourceId}`);
  });

  // Sync to DB
  await syncToDatabase(allSpeakers);
  
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
