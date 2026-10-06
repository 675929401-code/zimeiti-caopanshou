import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

const modelsRoute = read('src/app/api/admin/voice-studio/models/route.ts');
const modelByIdRoute = read('src/app/api/admin/voice-studio/models/[id]/route.ts');
const configsRoute = read('src/app/api/admin/voice-studio/configs/route.ts');
const configByIdRoute = read('src/app/api/admin/voice-studio/configs/[id]/route.ts');
const dashboardRoute = read('src/app/api/admin/voice-studio/dashboard/route.ts');
const adminUi = read('src/components/admin/VoiceStudioAdminTab.tsx');
const runtimeResolver = read('src/lib/server/voice-provider-config.ts');
const volcengineClient = read('src/lib/vs/volcengine.ts');

assert(!modelsRoute.includes('process.env.'), '模型管理 API 不读取环境密钥');
assert(!/SELECT[^'\n]*apiKey/i.test(modelsRoute), '模型管理 API 不从旧表读取明文密钥');
assert(modelsRoute.includes('VOICE_PROVIDER_SECRET_MANAGED_EXTERNALLY'), '模型管理 API 拒绝旧密钥写入');
assert(modelByIdRoute.includes('VOICE_PROVIDER_SECRET_MANAGED_EXTERNALLY'), '按 ID 更新同样拒绝旧密钥写入');
assert(!configsRoute.includes('process.env.') && !/SELECT[^'\n]*apiKey/i.test(configsRoute), '配置状态 API 不读取或返回密钥');
assert(configsRoute.includes('inspectVolcanoVoiceProviderConfig'), '配置状态 API 只读取统一配置的非敏感状态');
assert(configByIdRoute.includes('VOICE_PROVIDER_CONFIG_MANAGED_EXTERNALLY'), '旧配置写接口显式退役');
assert(!configByIdRoute.includes("UPDATE ApiConfig") && !configByIdRoute.includes("DELETE FROM ApiConfig"), '旧配置写接口不再修改本地假配置');
assert(dashboardRoute.includes('inspectVolcanoVoiceProviderConfig'), '仪表盘状态来自真实统一供应商配置');
assert(!dashboardRoute.includes('apiKey IS NOT NULL'), '仪表盘不再把旧 SQLite 密钥当成可用状态');
assert(!adminUi.includes('modelForm.apiKey') && !adminUi.includes('<Textarea'), '管理员页面不再回显或提交供应商密钥');
assert(adminUi.includes('主站统一配置中心管理'), '管理员页面说明真实密钥治理入口');
assert(runtimeResolver.includes('resolveProviderSecret') && runtimeResolver.includes(".from('plugins')"), '运行时供应商配置通过统一配置与密钥解析器读取');
assert(volcengineClient.includes('loadVolcanoVoiceProviderConfig'), '语音供应商客户端使用统一配置解析器');

console.log('PASS voice admin provider config: 14 assertions');
