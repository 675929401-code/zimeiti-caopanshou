import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const isRecord = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
export const sha256 = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const select = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key] ?? null]));

export function validateOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('ORIGIN_ONLY_REQUIRED');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('HTTPS_OR_LOOPBACK_HTTP_REQUIRED');
  return url.origin;
}

/** One bounded GET, without redirects/retries; pinned IP keeps the original Host and TLS hostname. */
export async function getJson(origin, route, { token, diagnosticHeaders = {}, connectAddress, timeoutMs = 15_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  validateOrigin(origin);
  if (!route.startsWith('/api/') || route.startsWith('//') || /[\r\n#]/u.test(route)) throw new Error('API_GET_ROUTE_REQUIRED');
  if (connectAddress && !isIP(connectAddress)) throw new Error('CONNECT_ADDRESS_MUST_BE_IP');
  const url = new URL(route, origin);
  if (url.origin !== origin) throw new Error('CROSS_ORIGIN_GET_FORBIDDEN');
  if (token && /[\r\n]/u.test(token)) throw new Error('INVALID_AUTHORIZATION');
  const started = Date.now();
  const allowedHeaders = ['x-admin-step-up', 'cookie'];
  for (const [key, value] of Object.entries(diagnosticHeaders)) if (!allowedHeaders.includes(key) || typeof value !== 'string' || /[\r\n]/u.test(value)) throw new Error('INVALID_DIAGNOSTIC_HEADER');
  const transport = { origin, route, method: 'GET', authentication: token ? 'explicit-bearer' : 'guest', connectAddress: connectAddress || null, tlsVerificationEnabled: url.protocol === 'https:', redirectsFollowed: 0, retries: 0 };
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(deadline); resolve({ ...transport, durationMs: Date.now() - started, ...value }); } };
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...diagnosticHeaders },
      rejectUnauthorized: true,
      ...(connectAddress ? { lookup: (_hostname, options, callback) => callback(null, options?.all ? [{ address: connectAddress, family: isIP(connectAddress) }] : connectAddress, isIP(connectAddress)) } : {}),
    }, response => {
      const status = response.statusCode || 0;
      const contentType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
      const metadata = { status, contentType, cacheControl: response.headers['cache-control'] || null, bytes: 0 };
      if (status !== 200) { finish({ ...metadata, ok: false, error: status >= 300 && status < 400 ? 'REDIRECT_REFUSED' : `HTTP_${status}` }); response.destroy(); return; }
      if (contentType !== 'application/json' && !contentType.endsWith('+json')) { finish({ ...metadata, ok: false, error: 'JSON_CONTENT_TYPE_REQUIRED' }); response.destroy(); return; }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish({ ...metadata, bytes, ok: false, error: 'RESPONSE_TOO_LARGE' }); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!isRecord(body)) throw new Error('OBJECT_REQUIRED');
          finish({ ...metadata, bytes, ok: true, body });
        } catch { finish({ ...metadata, bytes, ok: false, error: 'INVALID_JSON_OBJECT' }); }
      });
      response.on('error', () => finish({ ...metadata, bytes, ok: false, error: 'RESPONSE_STREAM_ERROR' }));
      response.on('aborted', () => finish({ ...metadata, bytes, ok: false, error: 'RESPONSE_ABORTED' }));
    });
    // Only safe codes are retained: remote error messages can include secrets or signed URLs.
    request.on('error', error => finish({ ok: false, status: null, error: /^[-A-Z_0-9]+$/u.test(String(error.code)) ? error.code : 'TRANSPORT_ERROR' }));
    const deadline = setTimeout(() => { finish({ ok: false, status: null, error: 'REQUEST_TIMEOUT' }); request.destroy(); }, timeoutMs);
    request.end();
  });
}

export function uniqueRows(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label}:ARRAY_REQUIRED`);
  const ids = new Set();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id.trim()) throw new Error(`${label}:ID_REQUIRED`);
    if (ids.has(row.id)) throw new Error(`${label}:DUPLICATE_ID`);
    ids.add(row.id);
  }
  return rows;
}

export function compareRows(left, right) {
  uniqueRows(left, 'left'); uniqueRows(right, 'right');
  const lhs = new Map(left.map(row => [row.id, row]));
  const rhs = new Map(right.map(row => [row.id, row]));
  const onlyLeft = [...lhs.keys()].filter(id => !rhs.has(id)).sort();
  const onlyRight = [...rhs.keys()].filter(id => !lhs.has(id)).sort();
  const changed = [...lhs.keys()].filter(id => rhs.has(id)).sort().flatMap(id => {
    const a = lhs.get(id), b = rhs.get(id);
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(key => canonicalJson(a[key]) !== canonicalJson(b[key]));
    return fields.length ? [{ id, fields, differences: Object.fromEntries(fields.map(key => [key, { left: a[key] ?? null, right: b[key] ?? null }])) }] : [];
  });
  return { status: onlyLeft.length || onlyRight.length || changed.length ? 'DIFFERENT' : 'EQUAL', onlyLeft, onlyRight, changed };
}

const AGENT_FIELDS = ['id', 'name', 'source', 'category', 'sort_order', 'is_active', 'user_access', 'model', 'model_id', 'cost_per_message', 'base_fee', 'enable_think_tags', 'deep_thinking_type', 'enable_web_search', 'token_billing_enabled'];
const AGENT_HASH_FIELDS = ['description', 'icon_url', 'cover_url', 'bot_id', 'preset_fields', 'guide_message', 'response_format', 'output_style'];
export function projectCatalog(agentPayload, categoryPayload, { displayCategory, getAgentNavigationKey }) {
  const categories = uniqueRows(categoryPayload.categories, 'categories').map(row => ({
    ...select(row, ['id', 'name', 'is_active', 'visibility', 'user_can_use', 'sort_order']),
    iconSha256: sha256(row.icon ?? null), descriptionSha256: sha256(row.description ?? null),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const categoryNames = new Map(categories.map(row => [row.name, row]));
  const counts = {};
  const rows = uniqueRows(agentPayload.agents, 'agents').map(row => {
    if (typeof row.name !== 'string') throw new Error('agents:NAME_REQUIRED');
    const displayKey = displayCategory(row), permissionGroup = getAgentNavigationKey(row);
    const categoryAllowsUse = categoryNames.get(row.category)?.user_can_use;
    const catalogAdmission = row.is_active === false ? 'DISABLED' : row.user_access === 'view_only' || categoryAllowsUse === false ? 'VIEW_ONLY'
      : row.is_active === true && row.user_access === 'available' ? 'AVAILABLE_AT_CATALOG_LEVEL' : 'UNVERIFIED';
    const count = counts[displayKey] ||= { visible: 0, enabled: 0, disabled: 0, viewOnly: 0, availableAtCatalogLevel: 0, unverified: 0 };
    count.visible++;
    if (row.is_active === true) count.enabled++;
    if (row.is_active === false) count.disabled++;
    if (catalogAdmission === 'VIEW_ONLY') count.viewOnly++;
    if (catalogAdmission === 'AVAILABLE_AT_CATALOG_LEVEL') count.availableAtCatalogLevel++;
    if (catalogAdmission === 'UNVERIFIED') count.unverified++;
    return { ...select(row, AGENT_FIELDS), ...Object.fromEntries(AGENT_HASH_FIELDS.map(key => [`${key}Sha256`, sha256(row[key] ?? null)])), displayCategory: displayKey, permissionGroup, catalogAdmission };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const opaquePublicModelBindings = agentPayload.agents.map(row => ({ id: row.id, modelPublicId: row.model_public_id ?? null })).sort((a, b) => a.id.localeCompare(b.id));
  return { status: 'VERIFIED', count: rows.length, unverified: rows.filter(row => row.catalogAdmission === 'UNVERIFIED').length, rows, categories, counts, opaquePublicModelBindings, sha256: sha256(rows), categoriesSha256: sha256(categories), scope: 'Actual HTTP catalog only; opaque model_public_id is provenance, not semantic binding identity. Membership, provider, billing and UI behavior unverified.' };
}

const CAPABILITY_FIELDS = ['type', 'family', 'deepThinking', 'webSearch', 'imageParsing', 'fileParsing', 'available', 'catalogVisible', 'priceReady', 'generationReady', 'protocolBindingReady', 'canaryVerified', 'compatibilityCode', 'availabilityCode', 'pricingMode', 'explicitlyFree', 'supportsImageInput', 'requiresImage', 'requiresSourceVideo', 'supportsSourceVideoInput', 'workflowInputMode', 'referenceInputMode', 'minReferenceImages', 'maxReferenceImages', 'minReferenceAudios', 'maxReferenceAudios', 'supportsAudioInput', 'supportsPrompt', 'requiresFirstFrame', 'requiresLastFrame', 'durationMode', 'minDuration', 'maxDuration', 'defaultDuration', 'nativeDurations', 'durationStep', 'resolutionTier', 'resolutionOptions', 'defaultResolution', 'resolutionPrices', 'aspectRatios', 'billingUnit', 'workspaceSurfaces', 'supportsRemoteCancel', 'supportsGenerateAudioToggle', 'capabilitiesVerified'];
export function projectModels(payload, kind) {
  const available = uniqueRows(payload.models, 'models');
  const unavailable = payload.unavailableModels == null ? [] : uniqueRows(payload.unavailableModels, 'unavailableModels');
  uniqueRows([...available, ...unavailable], 'combinedModels');
  const rows = [...available, ...unavailable].map(row => {
    if (!isRecord(row.capabilities)) throw new Error('models:CAPABILITIES_REQUIRED');
    const caps = row.capabilities;
    const publicPrice = row.publicPrice;
    const blocked = unavailable.includes(row) || ['available', 'priceReady', 'generationReady'].some(key => caps[key] === false);
    const requiredKeys = kind === 'text' ? ['priceReady'] : ['available', 'priceReady', 'generationReady'];
    const declared = requiredKeys.every(key => typeof caps[key] === 'boolean') && typeof publicPrice === 'number' && Number.isFinite(publicPrice) && publicPrice >= 0;
    return {
      ...select(row, ['id', 'displayName', 'variantLabel', 'publicPrice']),
      avatarSha256: sha256(row.avatarUrl ?? null),
      capabilities: select(caps, CAPABILITY_FIELDS),
      capabilitiesSha256: sha256(caps), tokenPricingSha256: sha256(row.tokenPricing ?? null),
      catalogSection: unavailable.includes(row) ? 'unavailableModels' : 'models',
      admission: blocked ? 'BLOCKED' : declared ? 'SERVER_DECLARED_READY' : 'UNVERIFIED',
      reasons: Object.fromEntries(['availabilityMessage', 'readinessMessage', 'verificationNotice'].map(key => [`${key}Sha256`, sha256(caps[key] ?? null)])),
    };
  });
  const semanticRows = rows.map(({ id: _opaqueId, ...semantic }) => semantic);
  return { status: 'VERIFIED', count: rows.length, serverDeclaredReady: rows.filter(row => row.admission === 'SERVER_DECLARED_READY').length, blocked: rows.filter(row => row.admission === 'BLOCKED').length, unverified: rows.filter(row => row.admission === 'UNVERIFIED').length, rows, apiOrderPreserved: true, sha256: sha256(semanticRows), scope: 'Actual workspace GET with full visible semantics, duplicate counts, API order and explicit server admission flags. Site-scoped pm_ IDs are provenance only; cross-environment physical binding, UI selection, member permission, input validity and provider success remain unverified.' };
}

/** Compare complete visible semantics, never identify models by names or site-scoped public IDs. */
export function compareModelSections(left, right) {
  const physicalBinding = { status: 'UNVERIFIED', reason: 'No trusted public-ID-to-internal-model mapping was supplied; semantic equality does not establish physical binding identity.' };
  if (left?.status !== 'VERIFIED' || right?.status !== 'VERIFIED') return { status: 'UNVERIFIED', leftStatus: left?.status || 'MISSING', rightStatus: right?.status || 'MISSING', physicalBinding };
  const groups = new Map();
  const sequences = {};
  for (const [side, section] of Object.entries({ left, right })) {
    uniqueRows(section.rows, `${side}Models`);
    sequences[side] = section.rows.map(({ id: _opaqueId, ...semantic }) => {
      const fingerprint = sha256(semantic);
      const group = groups.get(fingerprint) || { fingerprint, leftCount: 0, rightCount: 0, semantic };
      group[`${side}Count`]++;
      groups.set(fingerprint, group);
      return fingerprint;
    });
  }
  const multiplicityDifferences = [...groups.values()].filter(group => group.leftCount !== group.rightCount).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const orderKnown = left.apiOrderPreserved === true && right.apiOrderPreserved === true;
  const orderDifferences = orderKnown ? Array.from({ length: Math.max(sequences.left.length, sequences.right.length) }, (_, index) => ({ index, leftFingerprint: sequences.left[index] ?? null, rightFingerprint: sequences.right[index] ?? null })).filter(row => row.leftFingerprint !== row.rightFingerprint) : [];
  const multisetStatus = multiplicityDifferences.length ? 'DIFFERENT' : 'EQUAL';
  const orderStatus = !orderKnown ? 'UNVERIFIED' : orderDifferences.length ? 'DIFFERENT' : 'EQUAL';
  return {
    status: multisetStatus === 'DIFFERENT' || orderStatus === 'DIFFERENT' ? 'DIFFERENT' : orderStatus === 'UNVERIFIED' ? 'UNVERIFIED' : 'EQUAL',
    comparisonBasis: 'Complete normalized visible semantics, duplicate multiplicity and API order; excludes opaque model IDs.',
    counts: { left: left.rows.length, right: right.rows.length },
    semanticMultiset: { status: multisetStatus, multiplicityDifferences },
    apiOrder: { status: orderStatus, differences: orderDifferences, scope: 'API order can affect defaults and display order; order drift blocks semantic parity.' },
    opaqueIdSets: { ...compareRows(left.rows.map(row => ({ id: row.id })), right.rows.map(row => ({ id: row.id }))), scope: 'Site-scoped opaque IDs only. Differences do not mean models are missing and are excluded from semantic parity.' },
    physicalBinding,
  };
}

export function versionIdentity(payload) {
  const identity = select(payload, ['sourceVersion', 'buildId', 'releaseId', 'deployCommitSha', 'buildOutputDigest']);
  if (typeof identity.sourceVersion !== 'string' || !identity.sourceVersion) throw new Error('SOURCE_VERSION_REQUIRED');
  return identity;
}

export function projectOwnerDiagnostics(body) {
  if (body.schemaVersion !== 'configuration-identity.v1' || body.readOnly !== true) throw new Error('OWNER_DIAGNOSTICS_SCHEMA_REQUIRED');
  // Store only explicitly safe provenance/hashes. Never persist a raw diagnostic response.
  const sections = {};
  for (const key of ['agents', 'categories', 'membershipPackages', 'modelPoolRelease', 'workspaceModelRelease']) {
    const value = body[key];
    if (!isRecord(value)) throw new Error(`OWNER_DIAGNOSTICS_SECTION_REQUIRED:${key}`);
    sections[key] = { status: value.status, sha256: value.sha256 ?? null, count: value.count ?? null, identity: select(value.identity || {}, ['releaseId', 'releaseVersion', 'snapshotSha256', 'status']) };
    if (value.status === 'verified' && !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error(`OWNER_DIAGNOSTICS_DIGEST_REQUIRED:${key}`);
    if (Array.isArray(value.items)) {
      sections[key].items = value.items.map(row => {
        const { revision: _revision, version: _version, ...semantic } = row;
        return { id: String(row.id ?? row.key ?? ''), sha256: sha256(semantic) };
      }).sort((a, b) => a.id.localeCompare(b.id));
      uniqueRows(sections[key].items, `OWNER_DIAGNOSTICS_ITEMS:${key}`);
    }
  }
  return { status: body.configurationSource?.status === 'verified' && Object.values(sections).every(value => value.status === 'verified') ? 'VERIFIED' : 'UNVERIFIED', schemaVersion: body.schemaVersion, configurationSource: { status: body.configurationSource?.status || 'missing', sha256: sha256(body.configurationSource) }, sections, securityAuditMayAppend: body.policy?.securityAuditMayAppend === true };
}

export function compareOwnerDiagnostics(left, right) {
  if (left?.status !== 'VERIFIED' || right?.status !== 'VERIFIED') return { status: 'UNVERIFIED', leftStatus: left?.status || 'MISSING', rightStatus: right?.status || 'MISSING' };
  const sections = Object.fromEntries(Object.keys(left.sections).map(key => [key, {
    status: left.sections[key].sha256 === right.sections[key]?.sha256 ? 'EQUAL' : 'DIFFERENT',
    leftSha256: left.sections[key].sha256, rightSha256: right.sections[key]?.sha256 ?? null,
    ...(left.sections[key].items && right.sections[key]?.items ? { items: compareRows(left.sections[key].items, right.sections[key].items) } : {}),
  }]));
  return { status: Object.values(sections).every(value => value.status === 'EQUAL') ? 'EQUAL' : 'DIFFERENT', sections };
}

export function compareSection(left, right) {
  if (left?.status !== 'VERIFIED' || right?.status !== 'VERIFIED') return { status: 'UNVERIFIED', leftStatus: left?.status || 'MISSING', rightStatus: right?.status || 'MISSING' };
  return compareRows(left.rows, right.rows);
}

export function evaluateReport(report, { mode = 'informational', requireOwnerDiagnostics = false } = {}) {
  const blockers = [];
  if (report.comparison.source.status !== 'EQUAL') blockers.push(`source:${report.comparison.source.status}`);
  for (const [side, capture] of Object.entries(report.targets)) {
    if (capture.identityStable !== true) blockers.push(`${side}:IDENTITY_UNSTABLE_OR_UNVERIFIED`);
    if (capture.expectedSourceMatches === false) blockers.push(`${side}:EXPECTED_SOURCE_MISMATCH`);
    if (capture.principal?.status !== 'VERIFIED') blockers.push(`${side}:PRINCIPAL_UNVERIFIED`);
    if (capture.catalog?.unverified > 0) blockers.push(`${side}:CATALOG_ADMISSION_UNVERIFIED`);
    for (const [key, models] of Object.entries(capture.models)) if (models.unverified > 0) blockers.push(`${side}:${key}:ADMISSION_UNVERIFIED`);
  }
  if (report.comparison.audience.status !== 'EQUAL') blockers.push(`audience:${report.comparison.audience.status}`);
  for (const [key, value] of Object.entries({ catalog: report.comparison.catalog, categories: report.comparison.categories, ...report.comparison.models })) {
    if (value.status !== 'EQUAL') blockers.push(`${key}:${value.status}`);
  }
  if (requireOwnerDiagnostics && report.comparison.ownerDiagnostics.status !== 'EQUAL') blockers.push(`ownerDiagnostics:${report.comparison.ownerDiagnostics.status}`);
  return { mode, status: blockers.length ? 'NOT_ALIGNED' : 'ALIGNED_WITHIN_CHECKED_SCOPE', blockers, exitCode: mode === 'strict' && blockers.length ? 1 : 0, ownerDiagnosticsRequired: requireOwnerDiagnostics };
}
