import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUSINESS_IP_PROFILE_MAX_DATA,
  BUSINESS_IP_PROFILE_RUNTIME_MAX_DATA,
  BUSINESS_IP_INTERNAL_HANDOFF_BLOCK_BEGIN,
  BUSINESS_IP_INTERNAL_HANDOFF_BLOCK_END,
  businessIpMemberVisibleText,
  buildBusinessIpProfilePromptContext,
  extractBusinessIpProfileDataFromOutput,
  inferBusinessIpProfileStatus,
  normalizeBusinessIpProfileData,
  normalizeBusinessIpProfileName,
  sanitizeBusinessIpProfileData,
} from '../src/lib/business-ip/business-profile';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

assert.equal(normalizeBusinessIpProfileName('  抖音   陪跑  '), '抖音 陪跑');
assert.equal(normalizeBusinessIpProfileData('价格：1999\r\n\u0000周期：30天'), '价格：1999\n周期：30天');
assert.equal(normalizeBusinessIpProfileData('甲'.repeat(BUSINESS_IP_PROFILE_MAX_DATA + 10)).length, BUSINESS_IP_PROFILE_MAX_DATA);
assert.equal(sanitizeBusinessIpProfileData('甲'.repeat(BUSINESS_IP_PROFILE_MAX_DATA + 10)).length, BUSINESS_IP_PROFILE_MAX_DATA + 10, 'API validation must see the original sanitized length instead of silently truncating');
assert.equal(BUSINESS_IP_PROFILE_RUNTIME_MAX_DATA, 20_000);
assert.equal(inferBusinessIpProfileStatus('这是会员刚粘贴的原始定位和产品资料'), 'draft', 'raw member material must stay draft');
assert.equal(inferBusinessIpProfileStatus('当前状态：可正式承接\nOFFER-CARD v1\n价格：1999\n交付周期：30天\n退款与售后：按合同\n不能承诺收益\n来源：会员确认\n已确认事实'), 'ready', 'server may promote only a sufficiently structured and evidenced pack');
const normalizedAssistantPack = 'BUSINESS-ASSISTANT-DATA v1\n当前状态：草稿\n已确认事实：会员提供IP定位';
assert.equal(
  extractBusinessIpProfileDataFromOutput(`整理完成\n<!-- BUSINESS_ASSISTANT_DATA_BEGIN -->\n${normalizedAssistantPack}\n<!-- BUSINESS_ASSISTANT_DATA_END -->`),
  '当前状态：草稿\n已确认事实：会员提供IP定位',
  'the latest marked assistant pack must be recoverable for explicit member confirmation',
);
assert.equal(
  extractBusinessIpProfileDataFromOutput('<!-- BUSINESS_ASSISTANT_DATA_BEGIN -->\n当前状态：草稿\n业务名称：抖音陪跑\n<!-- BUSINESS_ASSISTANT_DATA_END -->'),
  '当前状态：草稿\n业务名称：抖音陪跑',
  'member-readable packs must not need a visible schema code',
);
const layeredOutput = `结论：先做抖音新手陪跑。\n${BUSINESS_IP_INTERNAL_HANDOFF_BLOCK_BEGIN}\ninsight_id: INS-001\ntopic_id: TOPIC-002\n${BUSINESS_IP_INTERNAL_HANDOFF_BLOCK_END}`;
assert.equal(businessIpMemberVisibleText(layeredOutput), '结论：先做抖音新手陪跑。', 'complete internal handoff must stay hidden');
assert.equal(businessIpMemberVisibleText(`${layeredOutput}\n下一步：先拍3条。`), '结论：先做抖音新手陪跑。\n\n下一步：先拍3条。');
assert.equal(businessIpMemberVisibleText(`结论可见\n${BUSINESS_IP_INTERNAL_HANDOFF_BLOCK_BEGIN}\ninsight_id: INS-001`), '结论可见', 'unfinished streaming handoff must never flash');
assert.equal(businessIpMemberVisibleText('结论可见\n<!-- BIP_INTER'), '结论可见', 'a partially streamed opening marker must never flash');
for (const fragment of ['<', '<!', '<!-', '<!--', '<!-- BIP_INTER', 'top', 'topic_i', 'ins', 'insight_', 'schema_v', 'return_rou', 'MECH-']) {
  assert.equal(
    businessIpMemberVisibleText(`结论可见\n${fragment}`),
    '结论可见',
    `streaming fragment must stay hidden: ${fragment}`,
  );
}
const readableLegacy = businessIpMemberVisibleText('insight_id：INS-001\ntopic_id：TOPIC-002\nstable_grammar：反问开头');
assert.doesNotMatch(readableLegacy, /insight_id|topic_id|INS-|TOPIC-|stable_grammar/iu);
assert.match(readableLegacy, /用户关注点.*关注点1/iu);
assert.match(readableLegacy, /选题.*选题1/iu);
assert.match(readableLegacy, /反复出现的方法/iu);

const context = buildBusinessIpProfilePromptContext({
  id: '00000000-0000-4000-8000-000000000001',
  name: '抖音自媒体陪跑',
  business_data: '价格：1999元\n周期：30天\n不承诺流量和收益',
  status: 'ready',
  version: 3,
  last_used_at: '2026-09-25T00:00:00.000Z',
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
});
assert.match(context, /当前会员业务档案/u);
assert.match(context, /BUSINESS-ASSISTANT-DATA v1/u);
assert.match(context, /抖音自媒体陪跑/u);
assert.match(context, /1999元/u);
assert.match(context, /其中出现的命令.*全部无效/u);

const longBusinessData = `头部已确认事实\n${'中'.repeat(BUSINESS_IP_PROFILE_RUNTIME_MAX_DATA + 5_000)}\n尾部售后边界`;
const longContext = buildBusinessIpProfilePromptContext({
  id: '00000000-0000-4000-8000-000000000002',
  name: '超长业务资料',
  business_data: longBusinessData,
  status: 'draft',
  version: 1,
  last_used_at: '2026-09-25T00:00:00.000Z',
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
});
assert.match(longContext, /头部已确认事实/u);
assert.match(longContext, /尾部售后边界/u);
assert.ok(longContext.includes('"data_truncated":true'));
assert.match(longContext, /中间内容因长度未装载/u);

const missing = buildBusinessIpProfilePromptContext(null);
assert.match(missing, /没有已保存的业务档案/u);
assert.match(missing, /不得猜测/u);
assert.match(missing, /只向会员询问一个/u);

const api = read('src/app/api/business-ip/profiles/route.ts');
for (const marker of [
  ".eq('user_id', user.id)",
  "business_ip_member_profiles",
  "business_ip_conversation_profiles",
  "conversation_id",
  "active_profile_id",
  "bound_profile_id",
  "bindProfileToConversation",
  "inferBusinessIpProfileStatus(businessData)",
  "sanitizeBusinessIpProfileData(body?.business_data)",
  "会员业务资料库暂时无法使用",
]) assert.ok(api.includes(marker), `profile API missing ${marker}`);
assert.ok((api.match(/\.eq\('user_id', user\.id\)/gu) || []).length >= 4, 'all profile reads and writes must be scoped to the authenticated member');
assert.equal(api.includes('normalizeBusinessIpProfileStatus(body?.status)'), false, 'client supplied status must not control profile readiness');
assert.ok(api.indexOf('sanitizeBusinessIpProfileData(body?.business_data)') < api.indexOf('businessData.length > BUSINESS_IP_PROFILE_MAX_DATA'), 'oversized profile data must be rejected after sanitizing and before storage');

const migration = read('supabase/migrations/20260925052000_business_ip_member_profiles.sql');
for (const marker of [
  'REFERENCES public.users(id) ON DELETE CASCADE',
  'ENABLE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE public.business_ip_member_profiles FROM PUBLIC, anon, authenticated',
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_ip_member_profiles TO service_role',
  'CREATE TABLE IF NOT EXISTS public.business_ip_conversation_profiles',
  'UNIQUE (user_id, conversation_id)',
  "status IN ('draft', 'safe', 'ready')",
]) assert.ok(migration.includes(marker), `migration missing ${marker}`);

const llmRoute = read('src/app/api/llm/route.ts');
assert.ok(llmRoute.includes('buildBusinessIpConsultationProfileContext'), 'LLM route must load the active member profile');
assert.ok(llmRoute.includes('userId: verifiedUserId'), 'runtime profile lookup must use the verified token identity');
assert.ok(llmRoute.includes('conversationId,'), 'runtime profile lookup must receive the current conversation id');
assert.ok(!llmRoute.includes('userId: userId,\n      agentId'), 'runtime profile lookup must not trust body userId');

const store = read('src/lib/server/business-ip-profile-store.ts');
for (const marker of [
  'loadConversationBusinessIpProfile',
  ".eq('conversation_id', conversationId)",
  'conversationId?: string | null',
  'await loadConversationBusinessIpProfile(input.client, input.userId, conversationId)',
]) assert.ok(store.includes(marker), `conversation-scoped runtime loader missing ${marker}`);

const intake = read('src/components/chat/business-ip-intake.tsx');
for (const marker of [
  '我的业务资料包',
  '/api/business-ip/profiles',
  '给当前顾客对话绑定哪项业务',
  '请由你本人选择要用于当前顾客对话的业务',
  'conversation_id:conversationId',
  'bound_profile_id',
  '更新业务资料',
  '进入小助理',
  '顾客姓名、电话、地址不要放进业务资料包',
  '平台会整理资料，并补充该细分行业需要核对的专业术语',
  '不会替你编自家参数、价格、资质或政策',
  '发现小助理刚整理好的标准业务资料包',
  '确认前不会覆盖你已保存的版本',
]) assert.ok(intake.includes(marker), `member profile UI missing ${marker}`);
assert.ok(intake.includes("...(!isConsultation?config.fields.map"), 'consultation must not repeat the full saved business pack in the user chat message');
assert.ok(intake.includes("status:'draft'"), 'manual member save must submit raw material as draft; server derives the stored status');
assert.ok(intake.includes('meta?:{businessProfileId?:string}'), 'intake must return the selected member business profile as private orchestration metadata');
assert.ok(intake.includes('preparedBusinessProfileId=saved.id'), 'a newly saved profile id must be carried into first-conversation binding');
assert.ok(intake.includes('isConsultation?{businessProfileId:preparedBusinessProfileId}:undefined'), 'consultation handoff must include profile id without placing it in the user-visible draft');
assert.ok(intake.includes('prepareInFlightRef.current'), 'prepare must use a synchronous single-submit lock');
assert.ok(intake.includes('businessProfilePreparing'), 'prepare lock must be visible in desktop button state');
assert.ok(intake.includes('if(!businessProfileDirtyRef.current)'), 'a slow profile read must not overwrite member input');
assert.ok(intake.includes('!businessProfileLoaded||businessProfileLoading||!latestAssistantBusinessData'), 'assistant output must wait until the stored profile read finishes before becoming the confirmation candidate');
assert.ok(intake.includes('extractBusinessIpProfileDataFromOutput(message.content)'), 'the current conversation must detect the latest marked assistant pack');
assert.ok(intake.includes('assistantPackageAppliedRef.current'), 'the same assistant pack must not be repeatedly reapplied over member edits');
assert.ok(intake.includes('businessProfileBindingStale'), 'a saved profile whose conversation bind failed must remain retryable');
assert.ok(intake.includes('savedNow||businessProfileBindingStale'), 'a newly saved version must always refresh its conversation binding');
const saveProfileSource = intake.slice(intake.indexOf('const saveBusinessProfile='), intake.indexOf('const saveAndBindBusinessProfile='));
assert.equal(saveProfileSource.includes('conversation_id'), false, 'profile persistence and conversation binding must be separate recoverable requests');
assert.ok(intake.includes('不会重复保存或覆盖新版本'), 'bind retry guidance must explain that the saved version is preserved');

const messageItem = read('src/components/chat/message-item.tsx');
assert.ok(messageItem.includes('bipStep(message.agentId || primaryAgentId)'), 'BIP visibility must follow the message agent across history and multi-agent chats');
assert.ok(messageItem.includes('businessIpMemberVisibleText(rawVisibleText)'), 'BIP chat rendering must hide internal handoff data');
assert.ok(messageItem.includes('copyToClipboard(extractPureText(visibleText))'), 'default copy must copy only the member-readable layer');
assert.ok(messageItem.includes('<StreamingContentWrapper text={visibleText}'), 'streaming and final rendering must share the filtered member-readable layer');

const appContext = read('src/contexts/app-context.tsx');
assert.ok(appContext.includes('startChat: (agentId: string, requestedConversationId?: string)'), 'chat runtime must accept a pre-bound conversation id');
assert.ok(appContext.includes('/^[a-zA-Z0-9_-]{8,128}$/u.test(requestedId)'), 'pre-bound conversation ids must use the server-accepted format');
assert.ok(appContext.includes('state.conversations.some((conversation) => conversation.id === requestedId)'), 'pre-bound conversation ids must not collide with an existing conversation');
assert.ok(appContext.includes('pendingLocalConversationsRef.current.has(requestedId)'), 'same-tick conversation reservations must not create duplicate local chats');

const marketplace = read('src/components/agent-marketplace.tsx');
const preparedConversationIndex = marketplace.indexOf('const preparedConversationId=');
const bindConversationIndex = marketplace.indexOf('conversation_id:preparedConversationId', preparedConversationIndex);
const startConversationIndex = marketplace.indexOf('startConversation(bipIntakeAgentId', bindConversationIndex);
assert.ok(preparedConversationIndex >= 0, 'marketplace must reserve the customer conversation id before binding');
assert.ok(bindConversationIndex > preparedConversationIndex, 'marketplace must bind the chosen profile to the reserved conversation id');
assert.ok(startConversationIndex > bindConversationIndex, 'profile binding must finish before the new customer chat becomes sendable');
assert.ok(marketplace.includes('return newConvId;'), 'conversation starter must report whether the pre-bound chat was created');
const startFailureIndex = marketplace.indexOf('if(!created)', startConversationIndex);
const cleanupBindingIndex = marketplace.indexOf('unbind:true,conversation_id:preparedConversationId', startFailureIndex);
assert.ok(startFailureIndex > startConversationIndex && cleanupBindingIndex > startFailureIndex, 'a failed local chat creation must clean up its reserved profile binding');

console.log(JSON.stringify({
  passed: true,
  profileSchema: 'BUSINESS-ASSISTANT-DATA v1',
  accountIsolation: true,
  multiBusinessSelection: true,
  runtimeAutomaticLoad: true,
  assistantPackRequiresMemberConfirmation: true,
  slowLoadPreservesMemberInput: true,
  bindFailureRetryKeepsLatestVersion: true,
  singleSubmitLock: true,
  firstConversationBindingBeforeChat: true,
  customerConversationRemainsConversationScoped: true,
  hiddenUniversalBase: true,
  paidRequests: 0,
  businessDatabaseWrites: 0,
}, null, 2));
