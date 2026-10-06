export function shouldSyncLegacyAgentMessagePricing(
  currentTokenBillingEnabled: unknown,
  nextTokenBillingEnabled: unknown,
): boolean {
  const effectiveTokenBilling = typeof nextTokenBillingEnabled === 'boolean'
    ? nextTokenBillingEnabled
    : currentTokenBillingEnabled === true;
  return effectiveTokenBilling !== true;
}
