import assert from 'node:assert/strict';
import fs from 'node:fs';

function source(file) {
  return fs.readFileSync(file, 'utf8');
}

function includes(file, value, message) {
  assert.ok(source(file).includes(value), message);
}

function excludes(file, value, message) {
  assert.ok(!source(file).includes(value), message);
}

const favorites = 'src/app/api/agent-favorites/route.ts';
includes(favorites, 'agent.user_access === "hidden" || agent.is_active === false', '隐藏或停用智能体必须对所有产品账号隐藏');
excludes(favorites, 'user.role !== "admin"', '管理员角色不得绕过隐藏智能体边界');

const trials = 'src/app/api/trial-plans/route.ts';
includes(trials, 'if (payload) {', '所有登录账号都必须查询自己的试用激活记录');
excludes(trials, "payload.role !== 'admin'", '管理员角色不得绕过试用使用状态');

const voiceTts = 'src/app/api/voice/tts/route.ts';
includes(voiceTts, 'publicVoiceResponse(await response.json())', 'TTS 必须统一返回公共 DTO');
includes(voiceTts, 'const effectiveExemption = quotedAmount <= 0;', '语音免扣只能来自零价格，不能来自管理员角色');
excludes(voiceTts, "if (user.role === 'admin') return response", '管理员不得读取 TTS 原始供应商响应');
excludes(voiceTts, 'effectiveExemption = userRole', '管理员角色不得改变语音扣费');

const voiceStatus = 'src/app/api/voice/generation-status/route.ts';
includes(voiceStatus, 'publicVoiceResponse(record.response)', '语音状态必须统一返回公共 DTO');
excludes(voiceStatus, "user.role === 'admin'", '管理员不得读取语音状态原始供应商响应');

const storyboard = 'src/app/api/storyboard/projects/route.ts';
includes(storyboard, 'role: "student", scope: "playback"', '分镜项目播放票据必须使用普通产品权限');
includes(storyboard, '.eq("user_id", owner)', '分镜项目关联数据必须按所有者收口');
excludes(storyboard, 'role === "admin"', '分镜项目不得给管理员签发特权票据');

const videoHistory = 'src/app/api/video/history/route.ts';
includes(videoHistory, 'role: "student",', '视频历史票据必须使用普通产品权限');
includes(videoHistory, '.eq("user_id", userId)', '视频历史必须按当前用户收口');
excludes(videoHistory, 'user.role', '视频历史不得根据管理员角色返回原始资源');

const videoPoll = 'src/app/api/video/poll/route.ts';
includes(videoPoll, 'role: "student",', '视频轮询票据必须使用普通产品权限');
includes(videoPoll, '.eq("user_id", userId)', '视频轮询必须按当前用户查找任务');
excludes(videoPoll, 'payload.role', '视频轮询不得根据管理员角色放宽任务所有权');

const chat = 'src/app/api/chat/route.ts';
includes(chat, 'if (verifiedUserId) {', '管理员与普通用户必须通过同一产品权限和余额预检');
includes(chat, 'checkPromptInjectionAsync(message, { isAdmin: false })', '管理员不得绕过提示词注入防护');
includes(chat, 'isAdmin: false,', '管理员不得绕过对话结算');
excludes(chat, 'userRole !== "admin"', '管理员角色不得跳过对话产品门禁');
excludes(chat, '_preIsAdmin', '管理员角色不得跳过请求安全或频率限制');

const digitalRoute = 'src/app/api/digital-human/long-generate/route.ts';
const digitalCreate = 'src/lib/digital-human-long-create.ts';
excludes(digitalRoute, "admin: auth.user.role === 'admin'", '数字人长视频不得传入管理员豁免');
excludes(digitalCreate, 'admin?: boolean', '数字人长视频创建器不得接受管理员豁免');
includes(digitalCreate, 'billingExempt: false', '数字人长视频必须显式关闭角色免计费');

const commerceSession = 'src/app/api/commerce/session/route.ts';
const commerceAuth = 'src/commerce/server/auth.ts';
const commerceAccess = 'src/commerce/server/main-account-access.ts';
includes(commerceSession, 'return withSession(await ensureSessionForMainUser({', '主站登录必须换取隔离的 Commerce 产品身份');
includes(commerceSession, 'role: current.role,', '桥接时必须记录数据库重新核验后的主站角色');
excludes(commerceSession, 'COMMERCE_ADMIN_PRODUCT_BRIDGE_DISABLED', '管理员不得因旧共享身份问题失去独立产品入口');
includes(commerceAuth, "session.role!=='user'", '既有管理员 Commerce cookie 必须失效');
includes(commerceAuth, "if(user.role!=='user')throw Error('COMMERCE_PRODUCT_ROLE_INVALID')", '新 Commerce cookie 只能承载普通产品角色');
includes(commerceAuth, "createHash('sha256').update(mainUserId).digest('hex').slice(0,40)", '每个主站账号必须映射到稳定且不可枚举的唯一 owner 名称');
includes(commerceAuth, 'mainRole,exempt:false', '反向绑定必须记录真实主站角色并关闭免计费');
excludes(commerceAuth, "get<{id:string;name:string;role:'admin'}>('settings','local-operator'", '共享 local-operator 不得再参与身份桥接');
includes(commerceAccess, "if (identity.role !== 'user')", '产品会话角色必须恒为 user');
excludes(commerceAccess, 'identity.role !== current.role', '产品角色不得被提升为主站管理员角色');

const governance = 'src/lib/admin-governance.ts';
includes(governance, 'pathname.startsWith("/api/admin/commerce")', '独立的后台 Commerce 配置入口必须保留能力门禁');
includes(governance, '"agents.manage" : "agents.view"', '后台 Commerce 配置必须继续区分读写能力');

const sidebar = 'src/components/app-sidebar.tsx';
includes(sidebar, 'next.push(STORYBOARD_WORKBENCH_SHORTCUT, COVER_STUDIO_SHORTCUT, COMMERCE_AGENT_SHORTCUT)', '记录当前产品入口可见性，避免误报入口已闭环');

console.log(JSON.stringify({
  passed: true,
  checks: [
    'hidden agents and trial usage have no admin role bypass',
    'voice responses are always public DTOs',
    'storyboard and video tickets never gain admin privilege',
    'chat security, rate, entitlement and billing paths apply to administrators',
    'digital-human long generation has no admin billing exemption',
    'legacy shared local-operator is retired in favor of one isolated product owner per main account',
    'independent /api/admin/commerce governance remains capability-gated',
  ],
  knownLimitations: [],
  networkCalls: 0,
  providerCalls: 0,
  databaseWrites: 0,
}, null, 2));
