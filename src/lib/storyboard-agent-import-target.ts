import { buildClientRequestFingerprint } from './browser-client-attempt';

/**
 * A click owns its import project. The handoff id is generated for every
 * click, so a new window never reopens the previous failed project; retries
 * within that same handoff keep the same project id and remain idempotent.
 */
export async function storyboardAgentImportProjectId(
  userId: string,
  handoffId: string,
  payload: { message_id: string; commit_key: string; machine_payload: unknown },
) {
  if (!userId || !handoffId || !payload.message_id || !payload.commit_key || !payload.machine_payload) throw new Error('完整的 Agent 分镜交接尚未就绪，未创建项目。');
  if (!/^[A-Za-z0-9._:-]{8,220}$/u.test(handoffId)) throw new Error('Agent 分镜交接编号无效，未创建项目。');
  const digest = await buildClientRequestFingerprint({ userId, handoffId, messageId: payload.message_id, commitKey: payload.commit_key, machinePayload: payload.machine_payload });
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('浏览器无法安全确认交接身份，未创建项目。');
  return `storyboard-agent-${digest}`;
}
