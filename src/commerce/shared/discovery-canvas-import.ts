import {normalizeCanvasGraph, type CanvasGraph, type CanvasNode, type CanvasEdge, type CanvasGroup, type CanvasKind} from './canvas-schema';
import {normalizeCanvasMentionDocument, type CanvasMention} from './canvas-mentions';
import type {DiscoveryCanvasImportOptions, DiscoveryCanvasImportResult, DiscoveryImportIssue, DiscoveryJson, DiscoveryNodeMigration} from './discovery-canvas-import-schema';
export type * from './discovery-canvas-import-schema';

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): Record<string, any> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const kindOf = (value: unknown): CanvasKind | null => value === 'markdown' ? 'text' : typeof value === 'string' && ['image', 'video'].includes(value) ? value as CanvasKind : null;
const supportedActions = new Set(['video_keyframe_grid', 'video_script_breakdown', 'face_mosaic', 'subtitle_erase']);
const supportedSkills = new Set(['character-fullbody-sheet', 'storyboard-element-replace']);
const nodeKeys = new Set(['local_id', 'type', 'title', 'position', 'size', 'z_index', 'card_role', 'input_slot', 'editor_state', 'current_payload', 'last_output_payload', 'current_version', 'sort_node_local_ids']);
const editorKeys = new Set(['prompt', 'resolution', 'aspect_ratio', 'duration_seconds', 'logical_model_key', 'model_code', 'output_format', 'tool_options', 'canvas_derivative_spec', 'canvas_derivative_action', 'image_skill_id', 'image_skill_label', 'image_skill_context']);
const payloadKeys = new Set(['asset_ref', 'thumbnail_asset_ref', 'asset_type', 'media_type', 'mime_type', 'preview_url', 'download_url', 'markdown', 'reference_mention_labels']);
const edgeKeys = new Set(['local_id', 'source_node_local_id', 'target_node_local_id', 'edge_type', 'label']);
const groupKeys = new Set(['local_id', 'node_local_ids', 'title', 'position', 'size', 'z_index', 'bounds_policy', 'meta']);
const cleanKey = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const isExecutionMetadata = (key: string) => {
  const k = cleanKey(key);
  return /(?:job|task|request|operation|trace)(?:id|ids)$/.test(k)
    || /(?:ticket|credential|authorization|authentication|billing|payment|charge|price|cost|token|secret|password|cookie|apikey|signature|receipt)(?:s|id|ids)?$/.test(k)
    || ['auth', 'authstate', 'authstatus', 'jwt', 'session', 'sessionid', 'headers', 'balance', 'credits', 'points', 'provider', 'storageprovider', 'supplier', 'facepresencedetection', 'assetcertification', 'certification', 'certified', 'authorized', 'sourcenodeid'].includes(k);
};

/** Pure: no random IDs, clock, filesystem, fetch, asset lookup or state writes. */
export function convertDiscoveryCanvas(input: unknown, options: DiscoveryCanvasImportOptions): DiscoveryCanvasImportResult {
  const issues: DiscoveryImportIssue[] = [];
  const migration: DiscoveryCanvasImportResult['migration'] = {schemaVersion: 1, nodes: [], groups: [], removedMetadataFields: 0};
  const issue = (severity: DiscoveryImportIssue['severity'], code: string, path: string, message: string) => issues.push({severity, code, path, message});
  // Keep unknown semantic fields for a read-only repair preview, but never receipts/credentials.
  // Values of the public prompt are content, not executable instructions or runtime metadata.
  const visited = new WeakSet<object>();
  let total = 0;
  function clone(value: unknown, depth = 0): DiscoveryJson {
    if (++total > 100000 || depth > 40) throw Error('快照层级或大小超过转换上限');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || visited.has(value)) throw Error('快照必须是无循环 JSON');
    visited.add(value);
    let result: DiscoveryJson;
    if (Array.isArray(value)) result = value.map(v => clone(v, depth + 1));
    else {
      const object: {[key: string]: DiscoveryJson} = Object.create(null);
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('快照包含非法对象字段');
        if (isExecutionMetadata(key)) { migration.removedMetadataFields++; continue; }
        if (/url$/i.test(key) && typeof child === 'string') {
          try {
            const url = new URL(child);
            let removed = false;
            if (url.username || url.password) {url.username = ''; url.password = ''; removed = true;}
            for (const param of [...url.searchParams.keys()]) if (isExecutionMetadata(param) || /^(x-amz-|x-tos-|x-oss-)/i.test(param)) {url.searchParams.delete(param); removed = true;}
            if (removed) {migration.removedMetadataFields++; object[key] = url.toString(); continue;}
          } catch { /* Public text/URLs remain untrusted display data; this module never fetches them. */ }
        }
        object[key] = clone(child, depth + 1);
      }
      result = object;
    }
    visited.delete(value);
    return result;
  }
  let sourceSnapshot: DiscoveryJson = null;
  const finish = (graph: CanvasGraph | null): DiscoveryCanvasImportResult => ({ok: graph !== null && !issues.some(i => i.severity === 'fatal'), executionReady: false, graph: issues.some(i => i.severity === 'fatal') ? null : graph, sourceSnapshot, issues, migration});
  try { sourceSnapshot = clone(input); } catch (e) { issue('fatal', 'INVALID_JSON', '$', e instanceof Error ? e.message : '快照无效'); return finish(null); }
  const source = record(sourceSnapshot) ?? {};
  if (source.schema_version !== 'discover_canvas.v1' || !Array.isArray(source.nodes) || !Array.isArray(source.edges) || !Array.isArray(source.groups) || !Array.isArray(source.public_assets)) {
    issue('fatal', 'UNSUPPORTED_SCHEMA', '$', '需要完整 discover_canvas.v1 快照及 nodes/edges/groups/public_assets'); return finish(null);
  }
  if (source.nodes.length > 100 || source.edges.length > 300 || source.groups.length > 100) {
    issue('fatal', 'GRAPH_LIMIT', '$', '源图超过本地图的 100 节点/300 连线/100 组上限，不能截断导入'); return finish(null);
  }
  if ([...source.nodes, ...source.edges, ...source.groups].some(v => !record(v))) {
    issue('fatal', 'INVALID_GRAPH_RECORD', '$', '节点、边与组必须是对象'); return finish(null);
  }
  const opt = record(options), ids = record(opt?.ids), assetMap = record(opt?.assetMap);
  if (!ids || !assetMap || !record(ids.nodes) || !record(ids.edges) || !record(ids.groups)) {
    issue('fatal', 'MISSING_MAPS', '$options', '必须显式传入独立节点、连线、分组与已归属复制素材映射'); return finish(null);
  }
  function knownFields(value: Record<string, any>, allowed: Set<string>, path: string) {
    for (const key of Object.keys(value)) if (!allowed.has(key)) issue('fatal', 'UNKNOWN_SEMANTICS', `${path}.${key}`, '未知语义字段保留在源快照，不能静默忽略后运行');
  }
  const nodeMap = new Map<string, Record<string, any>>(), publicAssets = new Map<string, Record<string, any>>();
  const originalIds = new Set<string>(), allocated = new Set<string>();
  for (const [name, rows] of [['nodes', source.nodes], ['edges', source.edges], ['groups', source.groups]] as const) {
    const seen = new Set<string>();
    rows.forEach((raw: unknown, index: number) => {
      const r = record(raw), id = r?.local_id;
      if (!identity(id) || seen.has(id)) issue('fatal', 'SOURCE_ID_INVALID', `${name}[${index}]`, '源标识缺失、非法或重复');
      else {seen.add(id); originalIds.add(id); if (name === 'nodes') nodeMap.set(id, r!);}
    });
  }
  for (let i = 0; i < source.public_assets.length; i++) {
    const a = record(source.public_assets[i]);
    if (!a || !identity(a.asset_ref) || publicAssets.has(a.asset_ref)) {issue('fatal', 'PUBLIC_ASSET_INVALID', `public_assets[${i}]`, '公开素材标识非法或重复'); continue;}
    publicAssets.set(a.asset_ref, a); originalIds.add(a.asset_ref);
  }
  function fresh(map: Record<string, any>, oldId: string, path: string): string | null {
    const id = own(map, oldId) ? map[oldId] : undefined;
    if (!identity(id) || originalIds.has(id) || allocated.has(id)) {issue('fatal', 'FRESH_ID_REQUIRED', path, '需要全新且不重用的映射标识'); return null;}
    allocated.add(id); return id;
  }
  const nodeIds = new Map<string, string>(), edgeIds = new Map<string, string>(), groupIds = new Map<string, string>();
  for (const [name, rows, target] of [['nodes', source.nodes, nodeIds], ['edges', source.edges, edgeIds], ['groups', source.groups, groupIds]] as const) {
    rows.forEach((raw: unknown, i: number) => {const r = record(raw); if (r && identity(r.local_id)) {const id = fresh(ids[name], r.local_id, `${name}[${i}].local_id`); if (id) target.set(r.local_id, id);}});
  }
  const mappedAssets = new Map<string, {id: string; kind: 'image' | 'video' | 'audio'}>();
  function asset(ref: unknown, expected: 'image' | 'video' | 'audio', path: string): string | null {
    if (!identity(ref) || !publicAssets.has(ref)) {issue('fatal', 'MISSING_PUBLIC_ASSET', path, '所引用素材不在公开素材清单，不能猜测 URL 或填占位结果'); return null;}
    const declaration = publicAssets.get(ref)!;
    const declaredKind = declaration.kind === 'thumbnail' ? 'image' : declaration.kind;
    if (declaredKind !== expected || typeof declaration.mime_type !== 'string' || !declaration.mime_type.startsWith(`${expected}/`)) {issue('fatal', 'ASSET_TYPE_MISMATCH', path, '源媒体类型和引用用途不一致'); return null;}
    const previous = mappedAssets.get(ref); if (previous) {if (previous.kind !== expected) issue('fatal', 'ASSET_TYPE_MISMATCH', path, '同一资产用于不同媒体类型'); return previous.kind === expected ? previous.id : null;}
    const mapped = own(assetMap!, ref) ? record(assetMap![ref]) : null;
    if (!mapped || mapped.kind !== expected || !identity(mapped.id) || originalIds.has(mapped.id) || allocated.has(mapped.id)) {issue('fatal', 'OWNED_ASSET_MAP_REQUIRED', path, '需要已归属复制且类型相符的全新资产映射'); return null;}
    allocated.add(mapped.id); mappedAssets.set(ref, {id: mapped.id, kind: expected}); return mapped.id;
  }
  const edges: CanvasEdge[] = [];
  source.edges.forEach((raw: unknown, i: number) => {
    const e = record(raw), path = `edges[${i}]`; if (!e) {issue('fatal', 'INVALID_EDGE', path, '连线格式无效'); return;}
    knownFields(e, edgeKeys, path);
    if (!['instruction', 'reference', 'derived'].includes(e.edge_type) || !nodeIds.has(e.source_node_local_id) || !nodeIds.has(e.target_node_local_id)) {issue('fatal', 'EDGE_SEMANTICS_UNRESOLVED', path, '边类型或端点无法完整映射'); return;}
    const sourceNode = nodeMap.get(e.source_node_local_id)!;
    const role = sourceNode.input_slot;
    if (role != null && (typeof role !== 'string' || role.length > 100)) issue('fatal', 'INPUT_SLOT_INVALID', path, '素材角色格式无效');
    edges.push({id: edgeIds.get(e.local_id) || '', source: nodeIds.get(e.source_node_local_id)!, target: nodeIds.get(e.target_node_local_id)!, ...(e.label == null ? {} : {label: e.label}), data: {edgeType: e.edge_type, ...(typeof role === 'string' && role ? {role} : {})}});
    if (role) issue('execution', 'ROLE_REQUIRES_REVIEW', path, '公开 input_slot 已保留，仍需核对目标技能的角色契约');
  });
  function ancestors(localId: string): Set<string> {
    const found = new Set<string>(), pending = [localId];
    while (pending.length) {const current = pending.pop()!; for (const e of source.edges) if (e.target_node_local_id === current && !found.has(e.source_node_local_id)) {found.add(e.source_node_local_id); pending.push(e.source_node_local_id);}}
    found.delete(localId); return found;
  }
  const nodes: CanvasNode[] = [];
  for (let i = 0; i < source.nodes.length; i++) {
    const n = record(source.nodes[i]), path = `nodes[${i}]`; if (!n) {issue('fatal', 'INVALID_NODE', path, '节点格式无效'); continue;}
    knownFields(n, nodeKeys, path);
    const kind = kindOf(n.type), editor = record(n.editor_state), payload = record(n.current_payload);
    if (!kind || !editor || !payload || !['generated', 'import_source'].includes(n.card_role)) {
      issue('fatal', 'NODE_SEMANTICS_UNSUPPORTED', path, '仅支持此批公开快照已取证的 image/video/markdown 及 import_source/generated 节点');
      migration.nodes.push({sourceLocalId: typeof n.local_id === 'string' ? n.local_id : '', targetId: nodeIds.get(n.local_id) || null, sourceType: typeof n.type === 'string' ? n.type : 'unknown', sourceRole: typeof n.card_role === 'string' ? n.card_role : 'unknown', inputSlot: typeof n.input_slot === 'string' ? n.input_slot : null, sourceVersion: typeof n.current_version === 'number' ? n.current_version : null, zIndex: typeof n.z_index === 'number' ? n.z_index : null, referenceOrderPublished: Array.isArray(n.sort_node_local_ids), orderedSourceLocalIds: [], orderedTargetNodeIds: [], instructionSourceLocalIds: [], referenceSourceLocalIds: [], derivedSourceLocalIds: [], prompt: typeof editor?.prompt === 'string' ? editor.prompt : '', outputText: typeof payload?.markdown === 'string' ? payload.markdown : null, outputAssetRef: typeof payload?.asset_ref === 'string' ? payload.asset_ref : null, logicalModelKey: null, imageSkillId: null, derivativeAction: null, parameters: {}, requiresReview: true});
      continue;
    }
    if (n.input_slot != null && (typeof n.input_slot !== 'string' || n.input_slot.length > 100)) issue('fatal', 'INPUT_SLOT_INVALID', path, '节点素材角色无效');
    if (n.z_index != null && (typeof n.z_index !== 'number' || !Number.isFinite(n.z_index))) issue('fatal', 'Z_INDEX_INVALID', path, '节点层级无效');
    if (n.current_version != null && (!Number.isInteger(n.current_version) || n.current_version < 1)) issue('fatal', 'SOURCE_VERSION_INVALID', path, '源版本无效');
    knownFields(editor, editorKeys, path + '.editor_state'); knownFields(payload, payloadKeys, path + '.current_payload');
    if (record(n.last_output_payload)) knownFields(n.last_output_payload, payloadKeys, path + '.last_output_payload');
    const incoming = source.edges.filter((e: any) => e.target_node_local_id === n.local_id);
    const order = n.sort_node_local_ids;
    if (order == null) issue('execution', 'REFERENCE_ORDER_NOT_PUBLIC', path + '.sort_node_local_ids', '公开快照未声明引用排序，不能把当前边数组顺序当成对标编号');
    else if (!Array.isArray(order) || order.some((id: unknown) => !identity(id) || !nodeMap.has(id)) || new Set(order).size !== order.length) issue('fatal', 'REFERENCE_ORDER_INVALID', path + '.sort_node_local_ids', '引用排序必须完整指向唯一源节点，不能按当前数组重排猜测');
    const ordered = Array.isArray(order) ? order.filter((id: unknown): id is string => identity(id)) : [];
    const ancestorsSet = ancestors(n.local_id);
    if (ordered.some((id: string) => !ancestorsSet.has(id))) issue('fatal', 'REFERENCE_ORDER_DISCONNECTED', path, '排序引用不属于此节点的上游');
    const rawPrompt = editor.prompt == null ? '' : editor.prompt;
    if (typeof rawPrompt !== 'string') issue('fatal', 'PROMPT_INVALID', path, '提示词必须为字符串');
    const prompt = typeof rawPrompt === 'string' ? rawPrompt : '';
    const outputText = typeof payload.markdown === 'string' ? payload.markdown : null;
    if (n.card_role === 'generated' && outputText && /(?<!\\)@(图片|文本|视频|音频|声音)\d+/u.test(outputText)) issue('execution', 'OUTPUT_TEXT_REFERENCES_REQUIRE_REVIEW', path, '公开生成文本中的编号按原文保留，其引用标签上下文需单独核对，不能在下游重新按序绑定');
    const spec = record(editor.canvas_derivative_spec), action = spec?.action ?? editor.canvas_derivative_action ?? null;
    if (action !== null && (!supportedActions.has(action) || editor.canvas_derivative_action && spec && editor.canvas_derivative_action !== action)) issue('fatal', 'UNKNOWN_DERIVATIVE', path, '未知或冲突的派生能力，禁止转为通用生成');
    else if (action) issue('execution', 'DERIVATIVE_NOT_PORTABLE', path, '已识别派生行为，但其本地执行与源版本关联尚未适配');
    if (spec) {
      knownFields(spec, new Set(['action', 'output', 'params', 'target_role', 'schema_version', 'source_version_policy']), path + '.editor_state.canvas_derivative_spec');
      if (spec.schema_version !== 1 || spec.source_version_policy !== 'latest' || spec.target_role !== 'primary') issue('fatal', 'DERIVATIVE_CONTRACT_UNKNOWN', path, '派生版本或源策略尚无本地映射');
      if (incoming.filter((e: any) => e.edge_type === 'derived').length !== 1) issue('fatal', 'DERIVATIVE_SOURCE_UNRESOLVED', path, '派生源不能由唯一 derived 边确认');
      const output = record(spec.output), params = record(spec.params);
      if (!output || output.node_type !== n.type || output.replace_mode !== 'replace_current' || !params) issue('fatal', 'DERIVATIVE_OUTPUT_UNRESOLVED', path, '派生输出或参数不匹配');
      if (output) knownFields(output, new Set(['node_type', 'replace_mode']), path + '.derivative.output');
      if (params) {
        const allowed = action === 'video_keyframe_grid' ? ['max_keyframes', 'split_strategy', 'max_grid_images', 'include_timestamps'] : action === 'subtitle_erase' ? ['options'] : [];
        knownFields(params, new Set(allowed), path + '.derivative.params');
        if (action === 'video_keyframe_grid' && (!Number.isInteger(params.max_keyframes) || params.max_keyframes < 1 || params.max_keyframes > 100 || params.split_strategy !== 'per_second' || !Number.isInteger(params.max_grid_images) || params.max_grid_images < 1 || typeof params.include_timestamps !== 'boolean')) issue('fatal', 'DERIVATIVE_PARAMS_UNKNOWN', path, '提帧参数类型或策略尚未取证');
        if (action === 'subtitle_erase') {
          const erase = record(params.options);
          if (!erase || erase.mode !== 'Text' || erase.output_encode_mode !== 'Size' || !Array.isArray(erase.erase_ratio_location)) issue('fatal', 'DERIVATIVE_PARAMS_UNKNOWN', path, '字幕擦除参数尚未取证');
          else {
            knownFields(erase, new Set(['mode', 'output_encode_mode', 'erase_ratio_location']), path + '.derivative.options');
            for (const region of erase.erase_ratio_location) {
              const r = record(region), keys = ['top_left_x', 'top_left_y', 'bottom_right_x', 'bottom_right_y'];
              if (!r || keys.some(k => typeof r[k] !== 'number' || r[k] < 0 || r[k] > 1) || r.top_left_x >= r.bottom_right_x || r.top_left_y >= r.bottom_right_y) issue('fatal', 'DERIVATIVE_REGION_INVALID', path, '擦除区域必须是有效的归一化矩形');
              else knownFields(r, new Set(keys), path + '.derivative.region');
            }
          }
        }
      }
    }
    if (editor.image_skill_id && !supportedSkills.has(editor.image_skill_id)) issue('fatal', 'UNKNOWN_IMAGE_SKILL', path, '未取证的图片技能不自动映射');
    else if (editor.image_skill_id) issue('execution', 'IMAGE_SKILL_REQUIRES_MAPPING', path, '保留公开图片技能标识，需核对本地输入契约后显式选择');
    if (editor.image_skill_context != null) {
      const context = record(editor.image_skill_context);
      if (!context || !supportedSkills.has(editor.image_skill_id)) issue('fatal', 'UNKNOWN_SKILL_CONTEXT', path, '技能上下文缺少可核对的技能身份');
      else {
        knownFields(context, new Set(['reference_script', 'user_requirement']), path + '.image_skill_context');
        if (Object.values(context).some(v => v !== null && typeof v !== 'string')) issue('fatal', 'UNKNOWN_SKILL_CONTEXT', path, '技能上下文只能保留已取证的字符串或空值');
      }
    }
    if (editor.tool_options != null) {
      const tools = record(editor.tool_options);
      if (!tools || Object.keys(tools).some(k => k !== 'generate_audio') || own(tools, 'generate_audio') && typeof tools.generate_audio !== 'boolean') issue('fatal', 'UNKNOWN_TOOL_OPTIONS', path, '未知工具能力或声音选项类型，不静默忽略');
    }
    if (n.card_role === 'generated') issue('execution', 'MODEL_MAPPING_REQUIRED', path, '生成节点保持生成用途，模型与技能必须独立核对，绝不根据 logical_model_key 自动配置');
    if (ordered.length) issue('execution', 'REFERENCE_ORDER_REQUIRES_ADAPTER', path, '保留原引用顺序与来源，本地执行器尚未消费公开 sort_node_local_ids');
    if (n.card_role === 'generated' && !prompt && !action) issue('execution', 'GENERATION_PROMPT_NOT_PUBLIC', path, '公开快照没有此节点的生成提示词；输出内容不冒充原提示词');
    const parameters: Record<string, DiscoveryJson> = Object.create(null);
    for (const key of ['resolution', 'aspect_ratio', 'duration_seconds', 'output_format', 'tool_options', 'image_skill_context', 'canvas_derivative_spec']) if (editor[key] !== undefined) parameters[key] = editor[key];
    const plan: DiscoveryNodeMigration = {
      sourceLocalId: n.local_id, targetId: nodeIds.get(n.local_id) || null,
      sourceType: n.type, sourceRole: n.card_role,
      inputSlot: typeof n.input_slot === 'string' ? n.input_slot : null,
      sourceVersion: typeof n.current_version === 'number' ? n.current_version : null,
      zIndex: typeof n.z_index === 'number' ? n.z_index : null,
      referenceOrderPublished: Array.isArray(order), orderedSourceLocalIds: ordered,
      orderedTargetNodeIds: ordered.map((id: string) => nodeIds.get(id) || ''),
      instructionSourceLocalIds: incoming.filter((e: any) => e.edge_type === 'instruction').map((e: any) => e.source_node_local_id),
      referenceSourceLocalIds: incoming.filter((e: any) => e.edge_type === 'reference').map((e: any) => e.source_node_local_id),
      derivedSourceLocalIds: incoming.filter((e: any) => e.edge_type === 'derived').map((e: any) => e.source_node_local_id),
      prompt, outputText, outputAssetRef: typeof payload.asset_ref === 'string' ? payload.asset_ref : null,
      logicalModelKey: typeof editor.logical_model_key === 'string' ? editor.logical_model_key : null,
      imageSkillId: typeof editor.image_skill_id === 'string' ? editor.image_skill_id : null,
      derivativeAction: typeof action === 'string' ? action : null, parameters, requiresReview: true,
    };
    migration.nodes.push(plan);
    const node: CanvasNode = {id: nodeIds.get(n.local_id) || '', type: 'commerce', position: n.position, ...(n.size ? {width: n.size.width, height: n.size.height} : {}), data: {kind, label: n.title, prompt: n.card_role === 'import_source' && kind === 'text' ? outputText ?? prompt : prompt, mode: n.card_role === 'generated' ? 'generate' : 'input'}};
    if (kind === 'text') {if (outputText !== null) node.data.resultText = outputText; else issue('fatal', 'TEXT_OUTPUT_MISSING', path, '文本快照缺少正文，不能以提示词伪装生成结果');}
    else {const id = asset(payload.asset_ref, kind, path + '.current_payload.asset_ref'); if (id) {if (n.card_role === 'generated') node.data.resultAssetIds = [id]; else node.data.assetIds = [id];}}
    if (payload.thumbnail_asset_ref != null) {const id = asset(payload.thumbnail_asset_ref, 'image', path + '.current_payload.thumbnail_asset_ref'); if (id) node.data.thumbnailAssetId = id;}
    for (const [from, to] of [['resolution', 'resolution'], ['aspect_ratio', 'aspectRatio'], ['duration_seconds', 'duration']] as const) if (editor[from] != null) (node.data as any)[to] = editor[from];
    if (editor.output_format != null) {
      if (typeof editor.output_format !== 'string' || !/^(png|jpe?g|webp)$/i.test(editor.output_format)) issue('execution', 'OUTPUT_FORMAT_REQUIRES_ADAPTER', path, '输出格式本地无法映射，保留待适配');
      else (node.data as any).outputFormat = editor.output_format.toUpperCase() === 'JPG' ? 'JPEG' : editor.output_format.toUpperCase();
    }
    if (kind === 'video' && editor.tool_options != null && own(editor.tool_options, 'generate_audio')) (node.data as any).generateAudio = (editor.tool_options as Record<string, unknown>).generate_audio === true;
    else if (kind !== 'video' && editor.tool_options != null && own(editor.tool_options, 'generate_audio')) issue('execution', 'AUDIO_OPTION_NOT_PORTABLE', path, '声音开关仅视频生成可映射，其余节点保留待核对');
    const text = node.data.prompt;
    const tokens = [...text.matchAll(/(?<!\\)@(图片|文本|视频|音频|声音)(\d+)/gu)];
    if ([...text.matchAll(/(?<!\\)@/gu)].some(m => !tokens.some(t => t.index === m.index))) issue('fatal', 'UNKNOWN_REFERENCE_SYNTAX', path, '存在此批契约尚未识别的 @ 引用写法，原文保留但不按编号或文件名猜绑定');
    const bindings = opt?.referenceBindings?.[n.local_id];
    const mentions: CanvasMention[] = [];
    const usedLabels = new Set<string>(), instances = new Map<string, string>();
    if (bindings !== undefined && !Array.isArray(bindings)) issue('fatal', 'REFERENCE_BINDING_INVALID', path, '引用绑定表必须为数组');
    for (const match of tokens) {
      const label = match[0].slice(1), available = Array.isArray(bindings) ? bindings.filter((b: any) => b?.label === label) : [];
      usedLabels.add(label);
      const b = available.length === 1 ? record(available[0]) : null;
      const sourceNode = b ? nodeMap.get(b.sourceNodeLocalId) : undefined;
      const sourceKind = sourceNode && kindOf(sourceNode.type), expected = match[1] === '图片' ? 'image' : match[1] === '文本' ? 'text' : match[1] === '视频' ? 'video' : 'audio';
      let valid = !!b && !!sourceNode && sourceKind === expected && ancestorsSet.has(b.sourceNodeLocalId) && identity(b.instanceId) && !originalIds.has(b.instanceId);
      const key = b ? JSON.stringify([b.sourceNodeLocalId, b.assetRef ?? null, b.slot ?? null]) : '';
      if (b) {
        if (instances.has(b.instanceId)) valid &&= instances.get(b.instanceId) === key;
        else if (allocated.has(b.instanceId)) valid = false;
        else {instances.set(b.instanceId, key); allocated.add(b.instanceId);}
        if (b.slot != null && (typeof b.slot !== 'string' || b.slot.length > 100)) valid = false;
        if (sourceNode?.input_slot != null && b.slot != null && b.slot !== sourceNode.input_slot) valid = false;
      }
      let assetId: string | null = null;
      if (valid && expected !== 'text') {
        if (b!.assetRef !== sourceNode!.current_payload?.asset_ref) valid = false;
        else {assetId = asset(b!.assetRef, expected, path + '.references.' + label); valid &&= !!assetId;}
      } else if (valid && b!.assetRef != null) valid = false;
      if (!valid) {issue('fatal', 'REFERENCE_BINDING_UNRESOLVED', path + '.references.' + label, '编号仅是展示文本，缺少可验证的源节点/素材绑定；不得按当前顺序猜测'); continue;}
      mentions.push({instanceId: b!.instanceId, assetId, sourceNodeId: nodeIds.get(b!.sourceNodeLocalId)!, slot: b!.slot ?? sourceNode!.input_slot ?? null, label, start: match.index!, end: match.index! + match[0].length, status: 'resolved'});
    }
    if (Array.isArray(bindings) && bindings.some((b: any) => !usedLabels.has(b?.label))) issue('fatal', 'REFERENCE_BINDING_UNUSED', path, '存在正文中没有的引用绑定，拒绝继承过期编号');
    if (mentions.length) {try {node.data.mention_document = normalizeCanvasMentionDocument({version: 1, text, mentions}, text);} catch {issue('fatal', 'MENTION_DOCUMENT_INVALID', path, '引用范围、正文或绑定无效');}}
    nodes.push(node);
  }
  const groups: CanvasGroup[] = [];
  source.groups.forEach((raw: unknown, i: number) => {
    const g = record(raw), path = `groups[${i}]`; if (!g) {issue('fatal', 'INVALID_GROUP', path, '分组无效'); return;}
    knownFields(g, groupKeys, path);
    migration.groups.push({sourceLocalId: g.local_id, targetId: groupIds.get(g.local_id) || null, zIndex: typeof g.z_index === 'number' ? g.z_index : null, boundsPolicy: typeof g.bounds_policy === 'string' ? g.bounds_policy : null});
    if (!Array.isArray(g.node_local_ids) || g.node_local_ids.some((id: string) => !nodeIds.has(id))) {issue('fatal', 'GROUP_MEMBER_UNRESOLVED', path, '分组必须保留全部原成员'); return;}
    groups.push({id: groupIds.get(g.local_id) || '', title: g.title, nodeIds: g.node_local_ids.map((id: string) => nodeIds.get(id)!), position: g.position, size: g.size});
  });
  issue('review', 'LAYOUT_PROVENANCE_SIDECAR', '$', '位置、尺寸、组和边保存在图；层级、引用排序、文字来源、原版本和不可移植参数需连同迁移清单保存');
  issue('execution', 'PUBLIC_WORKFLOW_NOT_EXECUTION_CERTIFIED', '$', '导入只转换已核实结构，不授予生成能力；需要显式适配与验收后另行创建本地执行版本');
  let graph: CanvasGraph | null = null;
  try {graph = normalizeCanvasGraph({nodes, edges, groups, viewport: source.canvas?.viewport});}
  catch (e) {issue('fatal', 'LOCAL_SCHEMA_CANNOT_REPRESENT', '$', e instanceof Error ? e.message : '本地画布 schema 无法完整表达源图');}
  return finish(graph);
}
