/**
 * S2/S5 入库前自校（s19）。纯函数，不连库、不调模型。
 *
 * 这里只实现 schema 管不到的门禁；schema 层（Storyboard / StoryboardResult / ShotVideoBundle）
 * 仍以评测脚本复跑为准：s2_check_v2.3.py、sr_check_v2.3.py、s5_precheck_v0.2.py。
 * 依据：/workspace/管线设计/S2-S5后端接线说明-v0.1.md §5.2（G5-2、G5-3、G5-4、G5-6）、
 *       /workspace/评测/预检-S5-v0.2/s5_precheck_v0.2.py（禁码按契约 v0.9 §9.2「使用步」）。
 */

/** S5 任务 error 不得取用的码（S6 码与 S4/S6 码）。 */
export const S5_FORBIDDEN_TASK_ERROR_CODES: ReadonlySet<string> = new Set([
  'COMPOSE_FAILED',
  'COMPOSE_MISSING_CLIP',
  'AI_LABEL_UNVERIFIED',
  'VOICE_NOT_IN_FIRST_BATCH',
]);
const S5_WRAPPER_CODES: ReadonlySet<string> = new Set(['SHOT_VIDEO_FAILED_RETRYABLE', 'SHOT_VIDEO_FAILED_PERMANENT']);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function collectErrors(value: unknown, path: string, out: Array<{ path: string; error: Json }>): void {
  if (Array.isArray(value)) { value.forEach((item, index) => collectErrors(item, `${path}/${index}`, out)); return; }
  if (!isObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'error' && isObject(nested)) out.push({ path: `${path}/error`, error: nested });
    collectErrors(nested, `${path}/${key}`, out);
  }
}

/** S5 ShotVideoBundle 写库前门禁（schema 以外部分）。返回问题列表，非空即拒绝写库。 */
export function s5BundleWriteIssues(bundle: unknown, options: { observedUpstreamCode?: string | null } = {}): string[] {
  if (!isObject(bundle)) return ['shot_video_bundle 不是对象'];
  const issues: string[] = [];
  const errors: Array<{ path: string; error: Json }> = [];
  collectErrors(bundle, '', errors);
  for (const { path, error } of errors) {
    const missing = ['code', 'retryable', 'message'].filter((key) => !(key in error));
    if (missing.length) issues.push(`G5-2 ${path} 缺 ${missing.join('/')}`);
  }
  const tasks = Array.isArray(bundle.tasks) ? bundle.tasks : [];
  tasks.forEach((task, index) => {
    if (!isObject(task)) { issues.push(`tasks/${index} 不是对象`); return; }
    const error = task.error;
    const output = isObject(task.output) ? task.output : {};
    if (task.state === 'succeeded' && (error !== null && error !== undefined || !output.clip_asset_id)) {
      issues.push(`G5-3 tasks/${index} succeeded 须有 clip_asset_id 且无 error`);
    }
    if (isObject(error) && typeof error.code === 'string' && S5_FORBIDDEN_TASK_ERROR_CODES.has(error.code)) {
      issues.push(`G5-4 tasks/${index} 取用非 S5 码 ${error.code}`);
    }
    if (isObject(error) && options.observedUpstreamCode && typeof error.code === 'string' && S5_WRAPPER_CODES.has(error.code)) {
      issues.push(`G5-6 tasks/${index} 有上游码 ${options.observedUpstreamCode} 却用包装码 ${error.code}`);
    }
  });
  return issues;
}

/** S2 分镜：shot_id 数字部分须等于 shot_index，shot_index 从 1 起连续。 */
export function storyboardShotIndexIssues(board: unknown): string[] {
  if (!isObject(board) || !Array.isArray(board.shots)) return ['storyboard.shots 缺失'];
  const issues: string[] = [];
  board.shots.forEach((shot, index) => {
    if (!isObject(shot)) { issues.push(`shots/${index} 不是对象`); return; }
    const match = /^shot_(\d{2,})$/.exec(String(shot.shot_id ?? ''));
    const shotIndex = shot.shot_index;
    if (!match) issues.push(`shots/${index} shot_id 形态无效：${String(shot.shot_id)}`);
    if (!(typeof shotIndex === 'number' && Number.isInteger(shotIndex) && shotIndex >= 1)) issues.push(`shots/${index} shot_index 须为 >=1 的整数`);
    else {
      if (match && Number(match[1]) !== shotIndex) issues.push(`shots/${index} shot_id 数字与 shot_index 不一致（${String(shot.shot_id)} vs ${shotIndex}）`);
      if (shotIndex !== index + 1) issues.push(`shots/${index} shot_index 须从 1 起连续，实际 ${shotIndex}`);
    }
  });
  return issues;
}

export type ShotAttemptTrigger = 'auto_retry' | 'user_regenerate';

/**
 * 逐镜重试/幂等键 {job_id}:{shot_id}:{attempt}（私人管家 11-16 23:22 口径）：
 * 自动重试沿用同一 attempt → 同一键 → 不重复扣费；用户点「重新生成」attempt+1 → 新键。
 */
export function nextShotAttempt(current: number, trigger: ShotAttemptTrigger): number {
  if (!Number.isInteger(current) || current < 1) throw Error('attempt 须为 >=1 的整数');
  return trigger === 'user_regenerate' ? current + 1 : current;
}

export function shotAttemptIdempotencyKey(input: { jobId: string; shotId: string; attempt: number }): string {
  const jobId = String(input.jobId || '').trim();
  const shotId = String(input.shotId || '').trim();
  if (!jobId || jobId.includes(':')) throw Error('job_id 无效');
  if (!/^shot_\d{2,}$/.test(shotId)) throw Error('shot_id 无效');
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw Error('attempt 须为 >=1 的整数');
  return `${jobId}:${shotId}:${input.attempt}`;
}
