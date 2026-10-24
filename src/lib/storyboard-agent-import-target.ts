import { buildClientRequestFingerprint } from './browser-client-attempt';

/** Stable owner/message/commit mapping; retries never create another project ID. */
export async function storyboardAgentImportProjectId(userId: string, payload: { message_id: string; commit_key: string; machine_payload: unknown }) {
  if (!userId || !payload.message_id || !payload.commit_key || !payload.machine_payload) throw new Error('完整的 Agent 分镜交接尚未就绪，未创建项目。');
  const digest = await buildClientRequestFingerprint({ userId, messageId: payload.message_id, commitKey: payload.commit_key, machinePayload: payload.machine_payload });
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('浏览器无法安全确认交接身份，未创建项目。');
  return `storyboard-agent-${digest}`;
}
