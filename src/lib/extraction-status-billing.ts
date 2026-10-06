/** Matches the keys used by each extraction route's wallet operation. */
export function extractionBillingPrefix(kind: string, clientRequestId: string): string {
  const namespaces: Record<string, string> = {
    single: 'extract', batch: 'extract-batch', search: 'extract-search', coze: 'extract-coze',
  };
  const namespace = namespaces[kind];
  if (!namespace) throw new Error('UNSUPPORTED_EXTRACTION_BILLING_KIND');
  return namespace + ':' + clientRequestId.replace(/[\\%_]/g, value => '\\' + value) + ':%';
}
