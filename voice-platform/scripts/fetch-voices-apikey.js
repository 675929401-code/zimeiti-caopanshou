/**
 * 火山引擎 ListSpeakers API - 多种认证方式尝试
 * 
 * 方式1: API Key (Bearer Token / X-Api-Key)
 * 方式2: V4签名 - 使用base64编码的SecretKey（不解码）
 * 方式3: V4签名 - 使用解码后的SecretKey
 */

const crypto = require('crypto');

// 凭据只从进程环境读取，禁止写入源码或日志。
const API_KEY = process.env.VOLCENGINE_API_KEY?.trim() ?? '';
const ACCESS_KEY = process.env.VOLC_ACCESS_KEY?.trim() ?? '';
const SECRET_KEY_B64 = process.env.VOLC_SECRET_KEY_B64?.trim() ?? '';
if (!API_KEY || !ACCESS_KEY || !SECRET_KEY_B64) {
  throw new Error('VOLCENGINE_API_KEY, VOLC_ACCESS_KEY and VOLC_SECRET_KEY_B64 are required');
}

// 解码SecretKey
const SECRET_KEY_DECODED = Buffer.from(SECRET_KEY_B64, 'base64').toString('utf8');

const HOST = 'open.volcengineapi.com';
const QUERY = 'Action=ListSpeakers&Version=2025-05-20';

function sha256Hex(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

async function tryApiKeyAuth() {
  console.log('\n=== 方式1: API Key 认证 ===');
  
  const bodyStr = JSON.stringify({
    ResourceIDs: ['seed-tts-2.0'],
    Page: 1,
    Limit: 5,
  });

  // 尝试 Bearer Token
  console.log('  1a: Bearer Token...');
  try {
    const resp = await fetch(`https://${HOST}/?${QUERY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: bodyStr,
    });
    const text = await resp.text();
    console.log(`  Status: ${resp.status}`);
    if (resp.ok) {
      const data = JSON.parse(text);
      if (!data.ResponseMetadata?.Error) {
        console.log(`  ✅ Bearer Token 成功! Total=${data.Result?.Total}`);
        return data.Result;
      }
      console.log(`  Error: ${data.ResponseMetadata.Error.Message}`);
    } else {
      console.log(`  Response: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`  Failed: ${err.message}`);
  }

  // 尝试 X-Api-Key header
  console.log('  1b: X-Api-Key header...');
  try {
    const resp = await fetch(`https://${HOST}/?${QUERY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
      },
      body: bodyStr,
    });
    const text = await resp.text();
    console.log(`  Status: ${resp.status}`);
    if (resp.ok) {
      const data = JSON.parse(text);
      if (!data.ResponseMetadata?.Error) {
        console.log(`  ✅ X-Api-Key 成功! Total=${data.Result?.Total}`);
        return data.Result;
      }
      console.log(`  Error: ${data.ResponseMetadata.Error.Message}`);
    } else {
      console.log(`  Response: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`  Failed: ${err.message}`);
  }

  return null;
}

async function tryV4Auth(secretKey, label) {
  console.log(`\n=== 方式2: V4签名 (${label}) ===`);
  console.log(`  SecretKey: ${secretKey.slice(0, 8)}...${secretKey.slice(-4)} (len=${secretKey.length})`);

  // 尝试多个可能的service名称
  const services = ['speech_saas_prod', 'speechtech', 'tts', 'speech', 'volc_megengine'];
  
  for (const service of services) {
    console.log(`\n  Service: ${service}`);
    
    const now = new Date();
    const dateTime = now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
    const date = dateTime.slice(0, 8);

    const bodyStr = JSON.stringify({
      ResourceIDs: ['seed-tts-2.0'],
      Page: 1,
      Limit: 5,
    });
    const bodyHash = sha256Hex(bodyStr);

    const canonicalHeaders = 
      'content-type:application/json; charset=utf-8\n' +
      `host:${HOST}\n` +
      `x-content-sha256:${bodyHash}\n` +
      `x-date:${dateTime}\n`;
    const signedHeaders = 'content-type;host;x-content-sha256;x-date';

    const canonicalRequest = [
      'POST', '/', QUERY, canonicalHeaders, signedHeaders, bodyHash,
    ].join('\n');

    const credentialScope = `${date}/cn-beijing/${service}/request`;

    const stringToSign = [
      'HMAC-SHA256', dateTime, credentialScope, sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(secretKey, date);
    const kRegion = hmac(kDate, 'cn-beijing');
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'request');

    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization = `HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      const resp = await fetch(`https://${HOST}/?${QUERY}`, {
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
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { console.log(`  Non-JSON: ${text.slice(0, 150)}`); continue; }
      
      if (data.ResponseMetadata?.Error) {
        const err = data.ResponseMetadata.Error;
        console.log(`  ❌ ${err.Code}: ${err.Message}`);
        // 如果是签名不匹配，继续尝试下一个service
        if (err.Code === 'SignatureDoesNotMatch') continue;
        // 其他错误也不继续
        continue;
      }
      
      if (data.Result?.Speakers) {
        console.log(`  ✅ 成功! Total=${data.Result.Total}, Speakers=${data.Result.Speakers.length}`);
        return { result: data.Result, service };
      }
      
      console.log(`  Unexpected: ${text.slice(0, 150)}`);
    } catch (err) {
      console.log(`  Request failed: ${err.message}`);
    }
  }

  return null;
}

async function main() {
  console.log('=== 火山引擎 ListSpeakers API 认证测试 ===');
  console.log(`AccessKey: ${ACCESS_KEY.slice(0, 12)}...${ACCESS_KEY.slice(-4)}`);
  console.log(`API Key: ${API_KEY.slice(0, 15)}...${API_KEY.slice(-8)}`);
  console.log(`SecretKey (base64): ${SECRET_KEY_B64.slice(0, 12)}...`);
  console.log(`SecretKey (decoded): ${SECRET_KEY_DECODED.slice(0, 8)}...${SECRET_KEY_DECODED.slice(-4)}`);

  // 方式1: API Key
  let result = await tryApiKeyAuth();
  if (result) {
    console.log('\n\n✅ API Key 认证成功！使用此方式获取全量音色。');
    return;
  }

  // 方式2a: V4签名 - 用base64原始字符串
  result = (await tryV4Auth(SECRET_KEY_B64, 'base64原值')) || result;
  if (result) {
    console.log(`\n\n✅ V4签名(base64原值) 成功！Service=${result.service}`);
    return;
  }

  // 方式2b: V4签名 - 用解码后的值
  result = (await tryV4Auth(SECRET_KEY_DECODED, '解码值')) || result;
  if (result) {
    console.log(`\n\n✅ V4签名(解码值) 成功！Service=${result.service}`);
    return;
  }

  // 方式3: 尝试不同的region
  console.log('\n=== 方式3: 尝试不同region ===');
  for (const region of ['cn-north-1', 'ap-southeast-1', 'us-east-1']) {
    console.log(`  Region: ${region}`);
    const now = new Date();
    const dateTime = now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
    const date = dateTime.slice(0, 8);
    const bodyStr = JSON.stringify({ ResourceIDs: ['seed-tts-2.0'], Page: 1, Limit: 5 });
    const bodyHash = sha256Hex(bodyStr);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-content-sha256:${bodyHash}\nx-date:${dateTime}\n`;
    const signedHeaders = 'content-type;host;x-content-sha256;x-date';
    const canonicalRequest = ['POST', '/', QUERY, canonicalHeaders, signedHeaders, bodyHash].join('\n');
    const credentialScope = `${date}/${region}/speech_saas_prod/request`;
    const stringToSign = ['HMAC-SHA256', dateTime, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    
    for (const sk of [SECRET_KEY_B64, SECRET_KEY_DECODED]) {
      const kDate = hmac(sk, date);
      const kRegion = hmac(kDate, region);
      const kService = hmac(kRegion, 'speech_saas_prod');
      const kSigning = hmac(kService, 'request');
      const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
      const authorization = `HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      
      try {
        const resp = await fetch(`https://${HOST}/?${QUERY}`, {
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
        const text = await resp.text();
        const data = JSON.parse(text);
        if (data.ResponseMetadata?.Error) {
          console.log(`    ${sk.slice(0, 6)}...: ${data.ResponseMetadata.Error.Code}`);
        } else if (data.Result?.Speakers) {
          console.log(`    ✅ 成功! region=${region}`);
          return;
        }
      } catch (err) {
        console.log(`    Error: ${err.message.slice(0, 60)}`);
      }
    }
  }

  console.log('\n\n❌ 所有认证方式都失败。');
  console.log('\n建议：');
  console.log('1. 登录火山引擎控制台 → 右上角头像 → 密钥管理 → 确认AK/SK是否有效');
  console.log('2. 检查AK/SK是否有语音合成服务的访问权限');
  console.log('3. 可能需要重新创建AK/SK');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
