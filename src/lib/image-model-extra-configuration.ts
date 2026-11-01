type Configuration = Record<string, unknown>;
type ConfigurationResult = { ok: true; value: Configuration } | { ok: false; error: string; code: string };

export const IMAGE_MODEL_READINESS_KEYS = [
  'canary_verified', 'canaryVerified', 'verification_notice', 'verificationNotice', '__model_activation_gate',
] as const;
const OWNED_KEYS = new Set<string>(['protocol', 'reference_transport', 'admin_notes', ...IMAGE_MODEL_READINESS_KEYS]);
const SENSITIVE_KEYS = new Set(['apikey', 'xapikey', 'accesstoken', 'refreshtoken', 'authorization', 'clientsecret', 'password', 'privatekey', 'secretvalue']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_BYTES = 64 * 1024;

function invalid(code = 'IMAGE_MODEL_PROTOCOL_CONFIG_INVALID', error = '图片接口配置必须是有效 JSON 对象，且不超过 64 KiB、16 层') : ConfigurationResult {
  return { ok: false, code, error };
}

/** Validate and copy every unknown provider field without accepting credentials. */
export function validateImageModelProtocolConfiguration(input: unknown): ConfigurationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const ancestors = new Set<object>();
  let failure: ConfigurationResult | undefined;
  function copy(value: unknown, depth: number): unknown {
    if (depth > 16) { failure = invalid(); return null; }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) { failure = invalid(); return null; }
    if (Object.prototype.toString.call(value) !== '[object Object]' && !Array.isArray(value)) { failure = invalid(); return null; }
    ancestors.add(value);
    const result: unknown[] | Configuration = Array.isArray(value) ? [] : {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) { failure = invalid(); break; }
      if (UNSAFE_KEYS.has(key)) { failure = invalid('IMAGE_MODEL_PROTOCOL_CONFIG_UNSAFE_KEY', '图片接口配置不能包含原型控制字段'); break; }
      if (SENSITIVE_KEYS.has(key.replace(/[^a-z0-9]/giu, '').toLowerCase())) {
        failure = invalid('IMAGE_MODEL_PROTOCOL_CONFIG_SENSITIVE_KEY', '图片接口配置不能包含密钥或认证字段，请使用独立密钥输入框'); break;
      }
      if (Array.isArray(value) && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)) { failure = invalid(); break; }
      const child = copy(descriptor.value, depth + 1);
      if (Array.isArray(result)) result[Number(key)] = child;
      else result[key] = child;
      if (failure) break;
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) failure = invalid();
    ancestors.delete(value);
    return result;
  }
  const value = copy(input, 0) as Configuration;
  if (failure) return failure;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BYTES) return invalid();
  return { ok: true, value };
}

/** Form extras own only fields that do not have dedicated or server-owned controls. */
export function imageModelExtraConfiguration(config: unknown): Configuration {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return Object.fromEntries(Object.entries(config).filter(([key]) => !OWNED_KEYS.has(key)));
}

export function parseImageModelExtraConfiguration(rawText: string): ConfigurationResult {
  if (typeof rawText !== 'string' || new TextEncoder().encode(rawText).byteLength > MAX_BYTES) return invalid();
  let parsed: unknown;
  try { parsed = rawText.trim() ? JSON.parse(rawText) : {}; } catch { return invalid(); }
  const result = validateImageModelProtocolConfiguration(parsed);
  if (!result.ok) return result;
  if (Object.keys(result.value).some(key => OWNED_KEYS.has(key))) {
    return invalid('IMAGE_MODEL_EXTRA_CONFIGURATION_OWNED_KEY', '附加配置不能填写协议、参考传输、管理员备注或只读验收状态，请使用对应控件');
  }
  return result;
}
