/**
 * 后台「提示词卡片」登记（s19，本机测试库阶段）。
 *
 * 依据：/workspace/提示词库/后台卡片-v0.3/后台对接规格-v0.3.md（字段名为草案，待对齐）。
 * - 一张卡 = 一个前台功能；只登记提示词文件的路径、版本、sha256 与品控/测试状态，
 *   提示词正文不入库（规格 §5），本模块拒绝任何正文类字段。
 * - 功能→模型仍以现有 commerce_operation_routes 已发布版本为准，这里只做只读展示；
 *   不新增 operationId（规格 §0-2/§0-3）。
 * - operationId 与 id 状态只出现在管理员投影里；本模块不提供面向普通用户的投影。
 * - 本文件不含任何模型 id、价格或积分数值。
 */
import { operationModelDisplay, type OperationRouteLike } from './operation-model-mapping';

export const PROMPT_CARD_FIELD_NAMES_STATUS = '草案（待网站开发字段结论对齐）';
export const PROMPT_CARD_QC_STATUSES = ['通过', '有条件通过', '草案', '未写', '无需提示词'] as const;
export const PROMPT_CARD_TEST_STATUSES = ['未测', '已测通过', '已测不合格'] as const;
export const PROMPT_CARD_YES_NO = ['是', '否', '未核'] as const;
export const PROMPT_CARD_MOUNT_MATCH = ['能对上', '待定', '未核实', '不适用'] as const;

export type PromptCardQcStatus = typeof PROMPT_CARD_QC_STATUSES[number];
export type PromptCardTestStatus = typeof PROMPT_CARD_TEST_STATUSES[number];

/** 库表 commerce_prompt_cards 一行（列名为草案）。 */
export interface PromptCardRow {
  card_id: string;
  section: string;
  feature_name: string;
  uses_agent_or_model: string;
  uses_agent_prompt: string;
  prompt_path: string | null;
  prompt_version: string | null;
  prompt_sha256: string | null;
  prompt_exists: boolean;
  qc_status: string;
  qc_score: number | null;
  qc_status_display: string;
  qc_source: string;
  test_status: string;
  release_status: string;
  mount_operation_ids: string[];
  mount_id_status: string;
  mount_match: string;
  field_names_status: string;
  source_note: string;
  imported_by: string;
  imported_at: string;
}

/** 管理员列表行。operationId 与 id 状态只在这里出现。 */
export interface PromptCardAdminItem {
  cardId: string;
  section: string;
  featureName: string;
  usesAgentPrompt: string;
  prompt: { path: string | null; version: string | null; sha8: string | null; exists: boolean };
  qcStatus: string;
  qcStatusDisplay: string;
  qcSource: string;
  testStatus: string;
  releaseStatus: string;
  mount: { operationIds: string[]; idStatus: string; match: string; displayModel: string; configured: boolean };
}

const CARD_ID = /^card-[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BODY_FIELDS = ['prompt_body', 'content', 'text', 'body', 'prompt_text'];
const includes = (list: readonly string[], value: unknown) => typeof value === 'string' && list.includes(value);

/** 导入/读出时的行校验；返回问题列表，空数组才允许写库。 */
export function promptCardRowIssues(row: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const id = String(row.card_id ?? '');
  if (!CARD_ID.test(id)) issues.push(`card_id 格式无效：${id || '空'}`);
  for (const field of BODY_FIELDS) if (field in row) issues.push(`${id}: 不允许正文字段 ${field}（正文只以文件为准）`);
  for (const field of ['section', 'feature_name', 'qc_status_display', 'release_status'] as const) {
    if (typeof row[field] !== 'string' || !String(row[field]).trim()) issues.push(`${id}: ${field} 必填`);
  }
  if (!includes(PROMPT_CARD_YES_NO, row.uses_agent_or_model)) issues.push(`${id}: uses_agent_or_model 取值无效`);
  if (!includes(PROMPT_CARD_YES_NO, row.uses_agent_prompt)) issues.push(`${id}: uses_agent_prompt 取值无效`);
  if (!includes(PROMPT_CARD_QC_STATUSES, row.qc_status)) issues.push(`${id}: qc_status 取值无效`);
  if (!includes(PROMPT_CARD_TEST_STATUSES, row.test_status)) issues.push(`${id}: test_status 取值无效`);
  if (!includes(PROMPT_CARD_MOUNT_MATCH, row.mount_match)) issues.push(`${id}: mount_match 取值无效`);
  const exists = row.prompt_exists === true;
  if (exists) {
    if (typeof row.prompt_path !== 'string' || !row.prompt_path.trim()) issues.push(`${id}: 有提示词文件时 prompt_path 必填`);
    if (typeof row.prompt_version !== 'string' || !row.prompt_version.trim()) issues.push(`${id}: 有提示词文件时 prompt_version 必填`);
    if (typeof row.prompt_sha256 !== 'string' || !SHA256.test(row.prompt_sha256)) issues.push(`${id}: prompt_sha256 须为 64 位小写十六进制`);
  } else if (row.prompt_path || row.prompt_sha256) {
    issues.push(`${id}: 无提示词文件时不得登记路径或 sha`);
  }
  // 规格 §3.4：通过/有条件通过必须带验收记录路径。
  if ((row.qc_status === '通过' || row.qc_status === '有条件通过') && !/\/品控\/.+\.md/.test(String(row.qc_source || ''))) {
    issues.push(`${id}: ${String(row.qc_status)} 必须带品控验收记录路径`);
  }
  // 规格 §3.5：未经朱先生确认与品控放行，测试状态只能是「未测」。
  if (row.test_status !== '未测') issues.push(`${id}: 本阶段 test_status 只能为「未测」`);
  const ops = row.mount_operation_ids;
  if (!Array.isArray(ops) || ops.some((op) => typeof op !== 'string' || !op.trim())) issues.push(`${id}: mount_operation_ids 须为字符串数组`);
  return issues;
}

/**
 * 管理员投影：只读拼上已发布路由的主模型；无路由或主模型为空都显示「未配置模型」，不报错。
 * allowedOperationIds 为代码登记表 + 已发布路由里的 id；卡片里出现登记表外的 id 时不显示为已对上。
 */
export function projectPromptCardForAdmin(row: PromptCardRow, publishedRoutes: OperationRouteLike[] | null, allowedOperationIds: ReadonlySet<string>): PromptCardAdminItem {
  const routes = new Map((publishedRoutes || []).map((route) => [route.operationId, route] as const));
  const ops = Array.isArray(row.mount_operation_ids) ? row.mount_operation_ids : [];
  const firstConfigured = ops.map((op) => operationModelDisplay(routes.get(op)?.primaryModelId)).find((item) => item.configured);
  const display = firstConfigured || operationModelDisplay('');
  const unknown = ops.filter((op) => !allowedOperationIds.has(op));
  return {
    cardId: row.card_id,
    section: row.section,
    featureName: row.feature_name,
    usesAgentPrompt: row.uses_agent_prompt,
    prompt: { path: row.prompt_path, version: row.prompt_version, sha8: row.prompt_sha256 ? row.prompt_sha256.slice(0, 8) : null, exists: row.prompt_exists },
    qcStatus: row.qc_status,
    qcStatusDisplay: row.qc_status_display,
    qcSource: row.qc_source,
    testStatus: row.test_status,
    releaseStatus: row.release_status,
    mount: {
      operationIds: ops,
      idStatus: unknown.length ? `${row.mount_id_status}；未在登记表：${unknown.join('、')}` : row.mount_id_status,
      match: unknown.length ? '未核实' : row.mount_match,
      displayModel: display.displayModel,
      configured: display.configured,
    },
  };
}
