/**
 * 测试 /api/v3/tts/create 端点是否有效
 */
const API_BASE = 'https://openspeech.bytedance.com';
const API_KEY = process.env.VOLCENGINE_API_KEY?.trim() ?? '';
if (!API_KEY) throw new Error('VOLCENGINE_API_KEY is required');

async function testCreateEndpoint() {
  console.log('=== 测试 /api/v3/tts/create 端点 ===\n');

  // 测试1: 标准TTS参数格式
  console.log('测试1: 标准TTS参数 (seed-tts-2.0)');
  try {
    const body = {
      req_params: {
        text: '你好世界',
        speaker: 'zh_female_vv_uranus_bigtts',
        model: 'seed-tts-2.0-expressive',
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
        },
      },
    };
    const resp = await fetch(`${API_BASE}/api/v3/tts/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
        'X-Api-Resource-Id': 'seed-tts-2.0',
        'X-Api-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    console.log(`  Status: ${resp.status}`);
    console.log(`  Response: ${text.slice(0, 300)}`);
    try {
      const data = JSON.parse(text);
      if (data.code === 20000000 || data.code === 0) {
        console.log('  ✅ /api/v3/tts/create 端点有效！');
        return true;
      } else {
        console.log(`  ❌ 业务错误: code=${data.code}, message=${data.message}`);
      }
    } catch {}
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err.message}`);
  }

  // 测试2: 简化参数
  console.log('\n测试2: 简化参数格式');
  try {
    const body2 = {
      text: '你好世界',
      speaker: 'zh_female_vv_uranus_bigtts',
      model: 'seed-tts-2.0-expressive',
      audio_params: { format: 'mp3', sample_rate: 24000 },
    };
    const resp2 = await fetch(`${API_BASE}/api/v3/tts/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
        'X-Api-Resource-Id': 'seed-tts-2.0',
      },
      body: JSON.stringify(body2),
    });
    const text2 = await resp2.text();
    console.log(`  Status: ${resp2.status}`);
    console.log(`  Response: ${text2.slice(0, 300)}`);
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err.message}`);
  }

  // 测试3: seed-audio-1.0 模型
  console.log('\n测试3: seed-audio-1.0 模型');
  try {
    const body3 = {
      model: 'seed-audio-1.0',
      text_prompt: '你好世界',
      audio_config: { format: 'mp3', sample_rate: 48000 },
    };
    const resp3 = await fetch(`${API_BASE}/api/v3/tts/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
        'X-Api-Resource-Id': 'seed-tts-2.0',
      },
      body: JSON.stringify(body3),
    });
    const text3 = await resp3.text();
    console.log(`  Status: ${resp3.status}`);
    console.log(`  Response: ${text3.slice(0, 300)}`);
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err.message}`);
  }

  // 对比测试: unidirectional 是否正常
  console.log('\n对比: /api/v3/tts/unidirectional (已知可用)');
  try {
    const body4 = {
      req_params: {
        text: '你好',
        speaker: 'zh_female_vv_uranus_bigtts',
        model: 'seed-tts-2.0-expressive',
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    };
    const resp4 = await fetch(`${API_BASE}/api/v3/tts/unidirectional`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
        'X-Api-Resource-Id': 'seed-tts-2.0',
      },
      body: JSON.stringify(body4),
    });
    const text4 = await resp4.text();
    console.log(`  Status: ${resp4.status}, Response length: ${text4.length}`);
    console.log(`  First 100 chars: ${text4.slice(0, 100)}`);
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err.message}`);
  }

  return false;
}

testCreateEndpoint().then(ok => {
  console.log(`\n=== 结论: /api/v3/tts/create ${ok ? '有效' : '无效或需要特殊参数'} ===`);
});
