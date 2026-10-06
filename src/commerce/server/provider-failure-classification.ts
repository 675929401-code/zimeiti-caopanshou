const EXPLICIT_IMAGE_REJECTION = /^IMAGE_PROVIDER_HTTP_(400|401|402|403|404|413|422|429)(?::|$)/u;
const EXPLICIT_GATEWAY_REJECTION = /^模型桥接返回 HTTP (400|401|402|403|404|413|422|429)$/u;
const EXPLICIT_PUBLIC_GATEWAY_REJECTION = /^MODEL_GATEWAY_HTTP_(400|401|402|403|404|413|422|429)$/u;
const EXPLICIT_BALANCE_REJECTION = /^(?:PROVIDER_RESULT_UNCONFIRMED:\s*)?UPSTREAM_BALANCE_EXHAUSTED(?::|$)/u;
const EXPLICIT_TEXT_REJECTION = /^TEXT_STREAM_(INTERRUPTED|INCOMPLETE)$/u;
const SAFE_PUBLIC_ERROR = /^[A-Z][A-Z0-9_: -]{2,90}$/u;

export type ProviderFailureDisposition = {
  status: 'failed' | 'unknown';
  error: string;
};

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

/**
 * Convert a provider exception into a stable public receipt result. Only
 * explicit, pre-dispatch-style rejections are terminal. Ambiguous transport,
 * timeout and 5xx failures remain unknown so the caller never replays them.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureDisposition {
  const message = failureMessage(error);
  if (EXPLICIT_BALANCE_REJECTION.test(message)) {
    return { status: 'failed', error: 'UPSTREAM_BALANCE_EXHAUSTED' };
  }
  const image = message.match(EXPLICIT_IMAGE_REJECTION);
  if (image) {
    return { status: 'failed', error: `IMAGE_PROVIDER_HTTP_${image[1]}` };
  }
  const gateway = message.match(EXPLICIT_GATEWAY_REJECTION);
  if (gateway) {
    return { status: 'failed', error: `MODEL_GATEWAY_HTTP_${gateway[1]}` };
  }
  if (EXPLICIT_PUBLIC_GATEWAY_REJECTION.test(message) || EXPLICIT_TEXT_REJECTION.test(message)) {
    return { status: 'failed', error: message };
  }
  return {
    status: 'unknown',
    error: SAFE_PUBLIC_ERROR.test(message) ? message : 'PROVIDER_RESULT_UNCONFIRMED',
  };
}

export function isExplicitImageProviderRejection(error: unknown) {
  return typeof error === 'string' && EXPLICIT_IMAGE_REJECTION.test(error);
}

export function isExplicitProviderRejection(error: unknown) {
  const message = failureMessage(error);
  return EXPLICIT_IMAGE_REJECTION.test(message)
    || EXPLICIT_GATEWAY_REJECTION.test(message)
    || EXPLICIT_PUBLIC_GATEWAY_REJECTION.test(message)
    || EXPLICIT_BALANCE_REJECTION.test(message);
}

export function confirmedFailureProviderCost(error: unknown, configuredCost: number) {
  return isExplicitProviderRejection(error) ? 0 : configuredCost;
}
