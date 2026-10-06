import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateCode, storeCode, verifyCode } from "../src/lib/email-code-store";
import { buildEmailSender } from "../src/lib/email";
import { isQqEmail, normalizeQqEmail, qqEmailError } from "../src/lib/qq-email";

const source = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

assert.equal(normalizeQqEmail(" 123456789@QQ.COM "), "123456789@qq.com");
assert.equal(isQqEmail("12345@qq.com"), true);
assert.equal(isQqEmail("123456789012@qq.com"), true);
assert.equal(isQqEmail("1234@qq.com"), false);
assert.equal(isQqEmail("012345@qq.com"), false);
assert.equal(isQqEmail("student@example.com"), false);
assert.equal(qqEmailError(""), "QQ邮箱为必填项");

assert.deepEqual(
  buildEmailSender('"自媒体操盘手" <123456@qq.com>', "123456@qq.com", "默认名称"),
  { name: "自媒体操盘手", address: "123456@qq.com" },
);
assert.deepEqual(
  buildEmailSender('"异常引号 <123456@qq.com>', "123456@qq.com", "默认名称"),
  { name: "异常引号", address: "123456@qq.com" },
);
assert.deepEqual(
  buildEmailSender("another@example.com", "123456@qq.com", "默认名称"),
  { name: "默认名称", address: "123456@qq.com" },
);
assert.deepEqual(
  buildEmailSender("带\r\n换行", "123456@qq.com", "默认名称"),
  { name: "带 换行", address: "123456@qq.com" },
);

const fixtureEmail = `${Math.floor(100000000 + Math.random() * 899999999)}@qq.com`;
const fixtureCode = generateCode();
assert.equal(storeCode(fixtureEmail, fixtureCode, "register").ok, true);
assert.equal(verifyCode(fixtureEmail, fixtureCode, "login").ok, false, "注册验证码不得用于登录");
assert.equal(verifyCode(fixtureEmail, fixtureCode, "register").ok, true, "注册验证码应按用途验证");
assert.equal(verifyCode(fixtureEmail, fixtureCode, "register").ok, false, "验证码成功使用后必须失效");

const codeStoreSource = source("src/lib/email-code-store.ts");
assert.match(codeStoreSource, /globalThis/);
assert.match(codeStoreSource, /__emailVerificationCodes/);

const registerRoute = source("src/app/api/auth/register/route.ts");
assert.match(registerRoute, /qqEmailError\(email\)/);
assert.match(registerRoute, /verifyCode\(email, code, ['"]register['"]\)/);
assert.match(registerRoute, /adminPasswordError\(password\)/);

const registerSendRoute = source("src/app/api/auth/register/send-code/route.ts");
assert.match(registerSendRoute, /normalizeQqEmail\(body\.email\)/);
assert.match(registerSendRoute, /storeCode\(email, code, ['"]register['"]\)/);
assert.doesNotMatch(registerSendRoute, /noVerify/);

const bindEmailRoute = source("src/app/api/auth/bind-email/route.ts");
assert.match(bindEmailRoute, /email_initial_bind:\$\{payload\.userId\}/);
assert.match(bindEmailRoute, /verifyCode\(email, code,/);
assert.match(bindEmailRoute, /EMAIL_IMMUTABLE/);
assert.doesNotMatch(bindEmailRoute, /noVerify/);

const changePasswordRoute = source("src/app/api/auth/change-password/route.ts");
assert.match(changePasswordRoute, /password_change:\$\{payload\.userId\}/);
assert.match(changePasswordRoute, /verifyCode\(email, String\(emailCode\), purpose\)/);

const profilePage = source("src/app/profile/page.tsx");
assert.match(profilePage, /QQ邮箱验证码/);
assert.match(profilePage, /handleSendPasswordCode/);
assert.doesNotMatch(profilePage, /emailNoVerify/);

const authMeRoute = source("src/app/api/auth/me/route.ts");
const updateHandler = authMeRoute.slice(authMeRoute.indexOf("export async function PUT"));
assert.doesNotMatch(updateHandler, /body\.email|updates\.email/, "通用资料接口不得绕过邮箱验证码直接改邮箱");
assert.match(updateHandler, /PHONE_CHANGE_REQUIRES_EMAIL_VERIFICATION/, "通用资料接口不得绕过邮箱验证码直接改手机号");

const changePhoneRoute = source("src/app/api/auth/change-phone/route.ts");
assert.match(changePhoneRoute, /phone_change:\$\{authorization\.actor\.userId\}:\$\{phone\}/);
assert.match(
  changePhoneRoute,
  /sendVerificationCode\(email, code, ['"]更换安全手机['"]\)/,
  "更换手机号验证码必须使用明确的邮件用途文案",
);

const loginForm = source("src/components/login-form.tsx");
assert.match(loginForm, /isQqEmail\(regEmail\)/);
assert.match(loginForm, /normalizeQqEmail\(regEmail\)/);
assert.match(loginForm, /至少8位，且需同时包含字母和数字/);

console.log(JSON.stringify({
  ok: true,
  checks: 32,
  networkCalls: 0,
  databaseWrites: 0,
  emailSends: 0,
  paidCalls: 0,
}, null, 2));
