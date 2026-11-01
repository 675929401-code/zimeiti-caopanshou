type Fields = Record<string, unknown>;
type MetadataResult = { ok: true; fields: Fields } | { ok: false; error: string; code: string };

/** Image rows store their operator note in protocol JSON, and order separately. */
export function imageModelAdminMetadata(input: Fields, currentProtocol: unknown = {}): MetadataResult {
  const fields: Fields = {};
  if (input.sort_order !== undefined) {
    const value = input.sort_order;
    const order = typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN;
    if (!Number.isSafeInteger(order) || order < 0 || order > 2_147_483_647) {
      return { ok: false, error: '排序号必须是明确的非负整数', code: 'IMAGE_MODEL_SORT_ORDER_INVALID' };
    }
    fields.sort_order = order;
  }
  const suppliedProtocol = Object.hasOwn(input, 'api_protocol_config') && input.api_protocol_config !== undefined;
  const suppliedNote = Object.hasOwn(input, 'admin_notes') && input.admin_notes !== undefined;
  if (suppliedNote && typeof input.admin_notes !== 'string') {
    return { ok: false, error: '管理员备注必须是文本', code: 'IMAGE_MODEL_ADMIN_NOTES_INVALID' };
  }
  const validatedProtocol = suppliedProtocol ? validateImageModelProtocolConfiguration(input.api_protocol_config) : undefined;
  if (validatedProtocol && !validatedProtocol.ok) return validatedProtocol;
  if (suppliedProtocol || suppliedNote) {
    const current = currentProtocol && typeof currentProtocol === 'object' && !Array.isArray(currentProtocol)
      ? currentProtocol as Fields : {};
    const protocol = validatedProtocol?.ok ? { ...validatedProtocol.value } : { ...current };
    for (const key of IMAGE_MODEL_READINESS_KEYS) {
      delete protocol[key];
      if (Object.hasOwn(current, key)) protocol[key] = current[key];
    }
    if (suppliedNote) protocol.admin_notes = input.admin_notes;
    else if (!Object.hasOwn(protocol, 'admin_notes') && Object.hasOwn(current, 'admin_notes')) protocol.admin_notes = current.admin_notes;
    fields.api_protocol_config = protocol;
  }
  return { ok: true, fields };
}
import { IMAGE_MODEL_READINESS_KEYS, validateImageModelProtocolConfiguration } from './image-model-extra-configuration';
