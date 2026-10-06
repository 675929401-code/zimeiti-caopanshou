/**
 * 使用SDK的Signer进行签名
 */
const { Service } = require('@volcengine/openapi');

const ACCESS_KEY = process.env.VOLC_ACCESS_KEY;
const SECRET_KEY = process.env.VOLC_SECRET_KEY;

async function main() {
  const service = new Service({
    accessKeyId: ACCESS_KEY,
    secretKey: SECRET_KEY,
    region: 'cn-beijing',
    host: 'open.volcengineapi.com',
    serviceName: 'speech_saas_prod',
  });

  // 用createJSONAPI + 传body为JSON字符串
  const listSpeakers = service.createJSONAPI('ListSpeakers', {
    Version: '2025-05-20',
    method: 'POST',
    contentType: 'json',
  });

  // requestData会作为body传入，SDK内部JSON.stringify
  const res = await listSpeakers({
    ResourceIDs: ['seed-tts-2.0'],
    Page: 1,
    Limit: 5,
  });

  if (res.ResponseMetadata?.Error) {
    console.error('Error:', res.ResponseMetadata.Error.Code, '-', res.ResponseMetadata.Error.Message);
  } else {
    console.log('Success! Total:', res.Result?.Total);
    console.log('Speakers:', res.Result?.Speakers?.length);
    if (res.Result?.Speakers?.[0]) {
      console.log('First:', res.Result.Speakers[0].VoiceType, '|', res.Result.Speakers[0].Name);
    }
  }
}

main().catch(err => console.error('Fatal:', err.message));
