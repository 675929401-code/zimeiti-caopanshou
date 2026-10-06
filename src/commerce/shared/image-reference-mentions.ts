/**
 * Browser-safe, independent implementation of image mention identity.
 * Public evidence exposes slotItemId/soltKey/mentionLabel; the target's private
 * implementation is unknown. instanceId identifies one use of an asset in a role.
 * No IO, model calls, storage, UUID generation, or implicit legacy-name migration.
 */
export type ImageReferenceInstance = {
  instanceId: string;
  assetId: string | null; // null until an owned upload completes
  slot: string; // an empty or incompatible role remains editable, but cannot compile
  name: string; // display only; never an identity key
};
export type ImageMentionStatus = 'resolved' | 'upload-pending' | 'unassigned' | 'missing';
export type ImageReferenceMention = {
  instanceId: string | null;
  assetId: string | null;
  slot: string | null;
  label: string;
  start: number; // JavaScript UTF-16 units, matching textarea selectionStart/End
  end: number;
  status: ImageMentionStatus;
};
export type ImageReferenceDocument = {version: 1; text: string; mentions: ImageReferenceMention[]};
export type ImageReferenceTextEdit = {start: number; end: number; text: string};
export type ImageReferenceOwnedAsset = {id: string; owner: string; type: string; sha256: string};
export type CompiledImageReference = {
  id: string; instanceId: string; slot: string; number: number; label: string; sha256: string;
};
export class ImageReferenceMentionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message); this.name = 'ImageReferenceMentionError';
  }
}
function fail(code: string, message: string): never {throw new ImageReferenceMentionError(code, message);}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function role(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function checkText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || text.length > 20000) fail('INVALID_TEXT', '图片正文无效或超过 20000 字符');
}
function tokens(text: string) {
  const found = [...text.matchAll(/@图片(\d+)/g)].map(m => ({label:m[0], start:m.index!, end:m.index!+m[0].length, digits:m[1]}));
  if (found.length > 100) fail('MENTION_LIMIT', '图片提及不能超过 100 处');
  return found;
}
function checkSlotOrder(slotOrder: readonly string[]): void {
  if (!Array.isArray(slotOrder) || slotOrder.length > 100 || slotOrder.some(s => !id(s) || s.length > 100) ||
    new Set(slotOrder).size !== slotOrder.length) fail('INVALID_SLOT_ORDER', '图片角色顺序无效或重复');
}

/** The ONLY numbering order: contract role order, then incoming order within a role.
 * Unassigned instances remain at the end for draft recovery; compile rejects them.
 * A same-asset/different-role pair remains two inputs, even when bytes are equal.
 */
export function orderImageReferenceInstances(references: readonly ImageReferenceInstance[], slotOrder: readonly string[]): ImageReferenceInstance[] {
  checkSlotOrder(slotOrder);
  if (!Array.isArray(references) || references.length > 100) fail('INVALID_REFERENCES', '图片实例列表无效');
  const instances = new Set<string>(), pairs = new Set<string>();
  const values = references.map((r, index) => {
    if (!r || !id(r.instanceId) || !(r.assetId === null || id(r.assetId)) || !role(r.slot) ||
      typeof r.name !== 'string' || r.name.length > 1000) fail('INVALID_REFERENCE', '图片实例缺少稳定 ID、资产或角色');
    if (instances.has(r.instanceId)) fail('DUPLICATE_INSTANCE', '图片实例 ID 不能重复');
    instances.add(r.instanceId);
    if (r.assetId !== null) {
      const key = JSON.stringify([r.assetId, r.slot]);
      if (pairs.has(key)) fail('DUPLICATE_ASSET_SLOT', '同一角色不能重复添加同一资产');
      pairs.add(key);
    }
    const rank = slotOrder.indexOf(r.slot);
    return {value:{instanceId:r.instanceId, assetId:r.assetId, slot:r.slot, name:r.name}, index, rank:rank < 0 ? slotOrder.length : rank};
  });
  return values.sort((a,b) => a.rank-b.rank || a.index-b.index).map(v => v.value);
}
function state(r: ImageReferenceInstance, slots: readonly string[]): Exclude<ImageMentionStatus,'missing'> {
  return !slots.includes(r.slot) ? 'unassigned' : r.assetId === null ? 'upload-pending' : 'resolved';
}
function fresh(text: string, refs: readonly ImageReferenceInstance[], slots: readonly string[]): ImageReferenceDocument {
  return {version:1, text, mentions:tokens(text).map(t => {
    const n = Number(t.digits), r = Number.isSafeInteger(n) && String(n) === t.digits && n > 0 ? refs[n-1] : undefined;
    return {label:t.label, start:t.start, end:t.end, instanceId:r?.instanceId ?? null,
      assetId:r?.assetId ?? null, slot:r?.slot ?? null, status:r ? state(r,slots) : 'missing'};
  })};
}

/** Only use for a NEW explicit numbered prompt. Legacy @filename text has no
 * recoverable identity and is left literal; callers must offer explicit rebinding.
 */
export function createImageReferenceDocument(text: string, references: readonly ImageReferenceInstance[], slotOrder: readonly string[]): ImageReferenceDocument {
  checkText(text); return fresh(text, orderImageReferenceInstances(references,slotOrder), slotOrder);
}

/** Structural validation also runs during draft recovery. Missing bindings are
 * retained rather than inferred from whichever file currently has the same number.
 */
function readDocument(value: unknown): ImageReferenceDocument {
  if (!value || typeof value !== 'object') fail('INVALID_DOCUMENT', '图片引用文档缺失');
  const d = value as ImageReferenceDocument;
  checkText(d.text);
  if (d.version !== 1 || !Array.isArray(d.mentions) || d.mentions.length > 100) fail('INVALID_DOCUMENT', '图片引用文档版本或结构无效');
  const parsed = tokens(d.text);
  if (parsed.length !== d.mentions.length) fail('UNBOUND_TOKEN', '正文存在未登记的图片提及');
  const mentions = d.mentions.map((m,i) => {
    const p = parsed[i];
    if (!m || m.start !== p.start || m.end !== p.end || m.label !== p.label ||
      !(m.instanceId === null || id(m.instanceId)) || !(m.assetId === null || id(m.assetId)) ||
      !(m.slot === null || role(m.slot)) || !['resolved','upload-pending','unassigned','missing'].includes(m.status)) {
      fail('INVALID_MENTION', '图片提及位置、身份或状态无效');
    }
    if (m.instanceId === null ? (m.assetId !== null || m.slot !== null || m.status !== 'missing') : m.slot === null) {
      fail('INVALID_MENTION_IDENTITY', '图片提及身份不完整');
    }
    return {instanceId:m.instanceId, assetId:m.assetId, slot:m.slot, label:m.label, start:m.start, end:m.end, status:m.status};
  });
  return {version:1, text:d.text, mentions};
}
function rewrite(d: ImageReferenceDocument, map: (m: ImageReferenceMention, index: number) => ImageReferenceMention): ImageReferenceDocument {
  let text = '', cursor = 0;
  const mentions = d.mentions.map((m,i) => {
    text += d.text.slice(cursor,m.start);
    const next = map({...m},i), start = text.length;
    text += next.label; cursor = m.end;
    return {...next, start, end:text.length};
  });
  text += d.text.slice(cursor);
  checkText(text);
  return {version:1, text, mentions};
}

/** Reorder/role changes update labels while preserving instance identity.
 * Removed or changed assets become missing. A missing mention is sticky until an
 * explicit rebind; adding an equal filename, asset, or even ID does not revive it.
 * Upload completion has its own explicit operation below.
 */
export function reconcileImageReferenceDocument(value: ImageReferenceDocument, references: readonly ImageReferenceInstance[], slotOrder: readonly string[]): ImageReferenceDocument {
  const d = readDocument(value), refs = orderImageReferenceInstances(references,slotOrder);
  return rewrite(d, m => {
    const index = refs.findIndex(r => r.instanceId === m.instanceId), r = refs[index];
    if (m.status === 'missing' || !r || r.assetId !== m.assetId) return {...m, status:'missing'};
    return {...m, slot:r.slot, label:'@图片'+(index+1), status:state(r,slotOrder)};
  });
}

function boundary(text: string, i: number) {
  return Number.isInteger(i) && i >= 0 && i <= text.length &&
    !(i > 0 && i < text.length && /[\uD800-\uDBFF]/.test(text[i-1]) && /[\uDC00-\uDFFF]/.test(text[i]));
}

/** Prefer an explicit textarea edit range when available, especially cut/paste.
 * Unchanged tokens retain identity; tokens actually touched by the edit bind to
 * current numbering. Offsets inside a surrogate pair are rejected.
 * References must already match the previous reconciled document.
 */
export function applyImageReferenceTextEdit(value: ImageReferenceDocument, edit: ImageReferenceTextEdit, references: readonly ImageReferenceInstance[], slotOrder: readonly string[]): ImageReferenceDocument {
  const refs = orderImageReferenceInstances(references,slotOrder);
  const d = validateImageReferenceDocument(value, value.text, refs, slotOrder, {allowUnresolved:true});
  if (!edit || !boundary(d.text,edit.start) || !boundary(d.text,edit.end) || edit.end < edit.start || typeof edit.text !== 'string') {
    fail('INVALID_EDIT_RANGE', '文字编辑区间无效，不能切开 Unicode 字符');
  }
  const text = d.text.slice(0,edit.start)+edit.text+d.text.slice(edit.end); checkText(text);
  const delta = edit.text.length-(edit.end-edit.start);
  const untouched = d.mentions.flatMap(m => m.end <= edit.start ? [{...m}] : m.start >= edit.end ? [{...m,start:m.start+delta,end:m.end+delta}] : []);
  const result = fresh(text,refs,slotOrder);
  result.mentions = result.mentions.map(m => untouched.find(k => k.start === m.start && k.end === m.end && k.label === m.label) || m);
  return result;
}

/** onChange fallback: preserve unchanged prefix/suffix and an unchanged token
 * sequence inside a multi-location edit. Ambiguous reused stale labels stay
 * missing. Use the range API for intentional same-text replacement/cut-and-paste.
 */
export function editImageReferenceDocument(value: ImageReferenceDocument, text: string, references: readonly ImageReferenceInstance[], slotOrder: readonly string[]): ImageReferenceDocument {
  checkText(text); const d = readDocument(value);
  let start = 0;
  while (start < d.text.length && start < text.length && d.text[start] === text[start]) start++;
  while (!boundary(d.text,start) || !boundary(text,start)) start--;
  let end = d.text.length, nextEnd = text.length;
  while (end > start && nextEnd > start && d.text[end-1] === text[nextEnd-1]) {end--; nextEnd--;}
  while (!boundary(d.text,end) || !boundary(text,nextEnd)) {end++; nextEnd++;}
  const result = applyImageReferenceTextEdit(d,{start,end,text:text.slice(start,nextEnd)},references,slotOrder);
  if (d.mentions.length === result.mentions.length && d.mentions.every((m,i) => m.label === result.mentions[i].label)) {
    // An onChange may include multiple edits (IME, normalization, programmatic
    // prefix + suffix). Identical token sequence is not permission to rebind.
    result.mentions = result.mentions.map((m,i) => ({...d.mentions[i],start:m.start,end:m.end}));
  } else {
    const delta = nextEnd-end;
    result.mentions = result.mentions.map(m => {
      const kept = d.mentions.some(old => old.label === m.label &&
        (old.end <= start && old.start === m.start && old.end === m.end ||
         old.start >= end && old.start+delta === m.start && old.end+delta === m.end));
      const stale = d.mentions.filter(old => old.status === 'missing' && old.label === m.label);
      if (kept || !stale.length) return m;
      const sameIdentity = stale.every(old => old.instanceId === stale[0].instanceId && old.assetId === stale[0].assetId && old.slot === stale[0].slot);
      return sameIdentity ? {...stale[0],start:m.start,end:m.end} : {...m,instanceId:null,assetId:null,slot:null,status:'missing'};
    });
  }
  return result;
}

/** Explicit user action for one stale token. The target is an instance, not name.
 * Also useful when confirming migration of a numbered legacy prompt.
 */
export function rebindImageReferenceMention(value: ImageReferenceDocument, mentionIndex: number, instanceId: string, references: readonly ImageReferenceInstance[], slotOrder: readonly string[]): ImageReferenceDocument {
  const d = reconcileImageReferenceDocument(value,references,slotOrder), refs = orderImageReferenceInstances(references,slotOrder);
  const index = refs.findIndex(r => r.instanceId === instanceId), r = refs[index];
  if (!Number.isInteger(mentionIndex) || mentionIndex < 0 || mentionIndex >= d.mentions.length || !r) fail('INVALID_REBIND', '请选择仍存在的图片实例和提及');
  return rewrite(d,(m,i) => i !== mentionIndex ? m : {...m,instanceId:r.instanceId,assetId:r.assetId,slot:r.slot,label:'@图片'+(index+1),status:state(r,slotOrder)});
}

/** Upload ID is supplied by the owned upload API, not derived from a local UUID.
 * Atomic return allows callers to save references and document together.
 * Repeated identical completion is safe; a conflicting completion cannot replace
 * an existing asset or restore a removed instance.
 */
export function completeImageReferenceUpload(value: ImageReferenceDocument, references: readonly ImageReferenceInstance[], slotOrder: readonly string[], completion: {instanceId:string; assetId:string}): {document:ImageReferenceDocument; references:ImageReferenceInstance[]} {
  const d = readDocument(value), refs = orderImageReferenceInstances(references,slotOrder);
  if (!completion || !id(completion.instanceId) || !id(completion.assetId)) fail('INVALID_UPLOAD', '上传回填身份无效');
  const r = refs.find(v => v.instanceId === completion.instanceId);
  if (!r) fail('UPLOAD_INSTANCE_REMOVED', '上传完成时原图片实例已移除');
  if (r.assetId !== null && r.assetId !== completion.assetId) fail('UPLOAD_ASSET_CONFLICT', '该实例已绑定其他资产，不能覆盖');
  const nextRefs = refs.map(v => v.instanceId === r.instanceId ? {...v,assetId:completion.assetId} : v);
  // Validation rejects same asset/same role collisions discovered only after upload.
  orderImageReferenceInstances(nextRefs,slotOrder);
  const filled = {...d, mentions:d.mentions.map(m => m.instanceId === r.instanceId && m.assetId === null && m.status !== 'missing' ? {...m,assetId:completion.assetId} : m)};
  return {references:nextRefs, document:reconcileImageReferenceDocument(filled,nextRefs,slotOrder)};
}

/** Strict by default. allowUnresolved is for draft editing/storage only; never
 * use it to authorize generation. It still rejects spoofed spans/roles/bindings.
 */
export function validateImageReferenceDocument(value: unknown, text: string, references: readonly ImageReferenceInstance[], slotOrder: readonly string[], options: {allowUnresolved?:boolean} = {}): ImageReferenceDocument {
  const d = readDocument(value), refs = orderImageReferenceInstances(references,slotOrder);
  if (d.text !== text) fail('TEXT_MISMATCH', '图片引用正文与提交正文不一致');
  for (const m of d.mentions) {
    if (m.status !== 'missing') {
      const index = refs.findIndex(r => r.instanceId === m.instanceId), r = refs[index];
      if (!r || m.assetId !== r.assetId || m.slot !== r.slot || m.label !== '@图片'+(index+1) || m.status !== state(r,slotOrder)) {
        fail('BINDING_MISMATCH', '图片编号、实例、资产和角色不一致，请重新核对引用');
      }
    }
    if (!options.allowUnresolved && m.status !== 'resolved') fail('UNRESOLVED_MENTION', '图片提及已失效、未分配角色或尚未上传，请修复后再生成');
  }
  return d;
}

/** Server integration MUST resolve ownedAssets from its own store immediately
 * before claiming/dispatching the job. Browser copies of owner/sha are not proof.
 * Existing image-input-contract validates role min/max and total count separately.
 * Do not trim text or independently sort/filter/deduplicate after this function.
 */
export function compileImageReferenceDocument(input: {
  document: unknown; text: string; references: readonly ImageReferenceInstance[];
  slotOrder: readonly string[]; owner: string; ownedAssets: readonly ImageReferenceOwnedAsset[];
}): {document:ImageReferenceDocument; references:CompiledImageReference[]} {
  if (!input || !id(input.owner) || !Array.isArray(input.ownedAssets)) fail('INVALID_OWNER_ASSETS', '缺少服务端资产核对结果');
  const refs = orderImageReferenceInstances(input.references,input.slotOrder);
  const document = validateImageReferenceDocument(input.document,input.text,refs,input.slotOrder);
  const assets = new Map<string,ImageReferenceOwnedAsset>();
  for (const a of input.ownedAssets) {
    if (!a || !id(a.id) || !id(a.owner) || typeof a.type !== 'string' || !/^[a-fA-F0-9]{64}$/.test(a.sha256)) fail('INVALID_OWNED_ASSET', '服务端资产记录无效');
    if (assets.has(a.id)) fail('DUPLICATE_OWNED_ASSET', '资产核对结果不能包含重复 ID');
    assets.set(a.id,a);
  }
  const references = refs.map((r,i) => {
    if (state(r,input.slotOrder) !== 'resolved') fail('UNRESOLVED_REFERENCE', '存在未分配角色或尚未上传的图片实例');
    const a = assets.get(r.assetId!);
    if (!a || a.owner !== input.owner || !/^image\/(png|jpeg|webp)$/.test(a.type)) fail('UNOWNED_IMAGE', '图片不存在、不属于当前账号或类型不是受支持的图片');
    return {id:a.id,instanceId:r.instanceId,slot:r.slot,number:i+1,label:'@图片'+(i+1),sha256:a.sha256.toLowerCase()};
  });
  return {document,references};
}
