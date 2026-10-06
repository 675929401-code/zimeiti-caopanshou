const { Service } = require('@volcengine/openapi');

async function test(ak, sk, label) {
  const service = new Service({
    accessKeyId: ak,
    secretKey: sk,
    region: 'cn-beijing',
    host: 'open.volcengineapi.com',
    serviceName: 'speech_saas_prod',
  });

  const listSpeakers = service.createJSONAPI('ListSpeakers', {
    Version: '2025-05-20',
    method: 'POST',
  });

  const res = await listSpeakers({
    ResourceIDs: ['seed-tts-2.0'],
    Page: 1,
    Limit: 5,
  });

  const err = res.ResponseMetadata?.Error;
  if (err) {
    console.log(label + ': FAIL ' + err.Code + ' - ' + err.Message.slice(0, 80));
  } else {
    console.log(label + ': OK Total=' + res.Result?.Total + ', Speakers=' + (res.Result?.Speakers?.length || 0));
    if (res.Result?.Speakers?.length > 0) {
      console.log('  First speaker:', res.Result.Speakers[0].VoiceType, '|', res.Result.Speakers[0].Name);
    }
  }
}

async function main() {
  const accessKeyId = process.env.VOLCENGINE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.VOLCENGINE_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Set VOLCENGINE_ACCESS_KEY_ID and VOLCENGINE_SECRET_ACCESS_KEY in the server environment before running this diagnostic.");
  }
  await test(accessKeyId, secretAccessKey, "environment credential");
}

main().catch(err => console.error('Fatal:', err.message));
