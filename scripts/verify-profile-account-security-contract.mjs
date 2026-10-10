#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const read = file => fs.readFileSync(file, "utf8");
const profile = read("src/app/profile/page.tsx");
const announcements = read("src/app/announcements/page.tsx");
const registerForm = read("src/components/login-form.tsx");
const registerRoute = read("src/app/api/auth/register/route.ts");
const bindEmail = read("src/app/api/auth/bind-email/route.ts");
const changePhone = read("src/app/api/auth/change-phone/route.ts");
const authMe = read("src/app/api/auth/me/route.ts");
const avatarRoute = read("src/app/api/auth/avatar/route.ts");
const avatarProxyRoute = read("src/app/api/avatars/route.ts");
const avatarPresets = read("src/lib/user-profile-avatar.ts");
const publicAssetManifest = JSON.parse(read("deploy/manifests/public-assets.v1.json"));
const avatarMigration = read("supabase/migrations/20261003140000_user_profile_avatars.sql");
const avatarSchemaCacheMigration = read("supabase/migrations/20261003143000_user_profile_avatars_schema_cache.sql");
const email = read("src/lib/email.ts");
const emailTemplate = read("src/lib/verification-email-template.ts");
const adminUsers = read("src/app/api/admin/users/route.ts");
const adminAccess = read("src/app/api/admin/access-control/route.ts");

assert.match(registerForm, /QQ邮箱/u, "注册表单必须明确要求QQ邮箱");
assert.match(registerForm, /isQqEmail\(regEmail\)/u, "注册表单必须在客户端校验QQ邮箱");
assert.match(registerRoute, /qqEmailError\(email\)/u, "注册接口必须在服务端校验QQ邮箱");

assert.match(bindEmail, /EMAIL_IMMUTABLE/u, "已绑定邮箱必须在API层保持不可变");
assert.match(bindEmail, /email_initial_bind:/u, "历史账号一次性绑定必须使用独立验证码用途");
assert.match(adminUsers, /EMAIL_IMMUTABLE/u, "会员管理接口不能改写安全邮箱");
assert.match(adminAccess, /EMAIL_IMMUTABLE/u, "管理员控制面不能改写安全邮箱");

assert.match(authMe, /PHONE_CHANGE_REQUIRES_EMAIL_VERIFICATION/u, "通用资料接口必须拒绝绕过邮箱验证改手机号");
assert.match(changePhone, /phone_change:\$\{authorization\.actor\.userId\}:\$\{phone\}/u, "手机号验证码必须绑定账号和目标手机号");
assert.match(changePhone, /sendVerificationCode\(email, code, '更换安全手机'\)/u, "手机号更换验证码必须发往当前安全邮箱并标明用途");
assert.match(adminUsers, /PHONE_CHANGE_REQUIRES_EMAIL_VERIFICATION/u, "会员后台不能绕过邮箱验证改手机号");
assert.match(adminAccess, /PHONE_CHANGE_REQUIRES_EMAIL_VERIFICATION/u, "超级管理不能绕过邮箱验证改手机号");
assert.match(profile, /\/api\/auth\/change-phone/u, "个人中心必须调用专用手机号更换接口");

const presetMatches = avatarPresets.match(/src:\s*'\/avatars\/profile-generated\/profile-avatar-\d+\.webp'/gu) || [];
assert.equal(presetMatches.length, 8, "必须提供恰好8个预设头像");
const presetPaths = Array.from({ length: 8 }, (_, index) => `public/avatars/profile-generated/profile-avatar-${String(index + 1).padStart(2, "0")}.webp`);
const manifestPaths = new Set(publicAssetManifest.files.map(file => file.path));
for (const presetPath of presetPaths) {
  assert.ok(fs.existsSync(presetPath), `预设头像源文件缺失: ${presetPath}`);
  assert.ok(fs.statSync(presetPath).size > 0, `预设头像源文件为空: ${presetPath}`);
  assert.ok(manifestPaths.has(presetPath), `预设头像未进入发布素材清单: ${presetPath}`);
}
assert.doesNotMatch(avatarPresets, /agent-cyber/u, "个人预设头像不能继续使用写实赛博人物组");
assert.doesNotMatch(avatarPresets, /cute-semantic/u, "个人预设头像不能复用应用广场原头像素材");
assert.match(profile, /参考应用广场气质重新设计的原创动画人物/u, "个人中心必须说明预设头像是原创重设计而非主页素材复用");
assert.match(avatarRoute, /requireOwnershipRecord: true/u, "上传头像必须登记资产归属");
assert.match(avatarRoute, /validateUploadBuffer/u, "上传头像必须校验真实文件类型");
assert.match(avatarRoute, /publicRead: true/u, "个人头像必须返回稳定可读URL");
assert.match(avatarRoute, /userProfileAvatarProxyUrl\(stored\.key, stored\.provider\)/u, "上传头像响应必须使用本站稳定代理地址");
assert.match(authMe, /select\("avatar_url,storage_provider,storage_key,source"\)/u, "个人资料读取必须以供应商和对象key为事实源");
assert.match(authMe, /userProfileAvatarProxyUrl\(row\.storage_key, row\.storage_provider\)/u, "历史上传头像必须转换为本站稳定代理地址");
assert.match(avatarProxyRoute, /let requestedProvider: StorageProviderType \| undefined/u, "头像代理必须把已验证供应商绑定到存储层类型");
assert.match(avatarProxyRoute, /if \(requestedProviderParam\) \{[\s\S]*?!isUserProfileAvatarStorageProvider\(requestedProviderParam\)[\s\S]*?requestedProvider = requestedProviderParam;/u, "头像代理必须先验证供应商再传入存储层");
assert.match(avatarProxyRoute, /storageManager\.read\(key, requestedProvider\)/u, "头像代理必须回到记录所属供应商读取");
assert.doesNotMatch(avatarProxyRoute, /requestedProviderParam\s+as\s+StorageProviderType/u, "头像代理不能用强制断言绕过供应商验证");
assert.match(avatarProxyRoute, /requestedProvider && !key\.startsWith\('user-profile-avatars'\)/u, "显式供应商读取必须限制在用户头像命名空间");
assert.match(avatarRoute, /resize\(512, 512, \{ fit: 'cover', position: 'attention' \}\)/u, "上传头像必须自动裁成512方图");
assert.match(avatarMigration, /REFERENCES public\.users\(id\) ON DELETE CASCADE/u, "头像记录必须与用户生命周期绑定");
assert.match(avatarSchemaCacheMigration, /NOTIFY pgrst, 'reload schema'/u, "头像迁移后必须刷新PostgREST结构缓存");
assert.match(profile, /USER_PROFILE_AVATAR_PRESETS\.map/u, "个人中心必须展示8种预设头像");
assert.match(profile, /profile-avatar-settings-dialog/u, "头像设置必须收进独立弹窗");
assert.match(profile, /profile-open-avatar-settings/u, "个人资料卡必须提供明确头像设置入口");
assert.doesNotMatch(profile, /min-w-\[390px\].*选择个人头像/su, "头像选择器不能再占据个人中心顶部横排");

assert.match(profile, /AssetAvailabilityBar/u, "资产概览必须使用单色可用量进度条");
assert.doesNotMatch(profile, /assets\.cash\.totalConsumed \/ assets\.cash\.totalRecharged/u, "现金进度条不能继续使用双段旧算法");
assert.doesNotMatch(profile, /assets\.credits\.totalConsumed \/ assets\.credits\.totalRecharged/u, "积分进度条不能继续使用双段旧算法");

assert.match(announcements, /grid-cols-\[390px_minmax\(0,1fr\)\]/u, "公告中心必须采用独立索引与阅读区");
assert.match(announcements, /announcement-reading-pane/u, "公告详情必须拥有独立阅读容器");
assert.match(profile, /profile-announcement-center/u, "个人中心公告摘要必须使用新版入口");

assert.match(emailTemplate, /<meta charset="UTF-8">/u, "HTML验证码邮件必须声明UTF-8");
assert.match(email, /textEncoding: 'base64'/u, "验证码邮件正文必须使用稳定MIME传输编码");
assert.match(email, /text: message\.text/u, "验证码邮件必须提供纯文本备选正文");
assert.match(email, /html: message\.html/u, "验证码邮件必须提供专业HTML正文");
assert.match(emailTemplate, /normalizeDisplayText/u, "邮件品牌名必须修复历史乱码后再渲染");

console.log(JSON.stringify({
  passed: true,
  checks: 53,
  paidCalls: 0,
  productionWrites: 0,
}, null, 2));
