const DIGITAL_HUMAN_PROTOCOLS = new Set([
  'dashscope_wan_s2v',
  'dashscope_video_retalk',
  'volcengine_digital_human',
]);

function normalizedWorkspaceSurfaces(row: Record<string, unknown>): Set<string> {
  const config = row.api_protocol_config && typeof row.api_protocol_config === 'object'
    ? row.api_protocol_config as Record<string, unknown>
    : {};
  const values = Array.isArray(config.workspace_surfaces) ? config.workspace_surfaces : [];
  return new Set(values.map(String).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

/**
 * Recognize dedicated digital-human models even when a legacy database row
 * predates the workspace_surfaces field. This predicate is shared by catalog
 * and submission gates so a model cannot be listed without the same owned-
 * asset and duration validation being applied at submission time.
 */
export function isDigitalHumanWorkspaceModel(row: Record<string, unknown>): boolean {
  if (normalizedWorkspaceSurfaces(row).has('digital-human')) return true;
  const protocol = String(row.protocol_type || '').trim().toLowerCase();
  if (DIGITAL_HUMAN_PROTOCOLS.has(protocol)) return true;
  const config = row.api_protocol_config && typeof row.api_protocol_config === 'object'
    ? row.api_protocol_config as Record<string, unknown>
    : {};
  const identity = [
    protocol,
    row.name,
    row.model_name,
    config.display_name,
    config.provider,
    config.model,
    config.model_name,
    config.workflow_input_mode,
    config.req_key,
  ].map((value) => String(value || '')).join(' ').toLowerCase();
  return /数字人|口播|口型|对口型|lip[\s_-]*sync|talking[\s_-]*head|retalk|omni[\s_-]*human|realman[\s_-]*change[\s_-]*lips/u.test(identity);
}
