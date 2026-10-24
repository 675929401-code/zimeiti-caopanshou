import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseStructuredAgentOutput } from '../src/lib/structured-agent-output';
import { buildHomepageStoryboardDraftDetail, readStoryboardIntakeSnapshotForMessage, resolveStoryboardHandoffContract } from '../src/lib/agent-workbench-handoff';
import { validateStoryboardDirectorPackage, type StoryboardDirectorPackage } from '../src/lib/storyboard-director-protocol';
import { buildHistoricalStoryboardMessageDraft, parseLegacyStoryboardDraftImport } from '../src/lib/storyboard-legacy-prompt-draft';

// Inspect only the current local owner's director replies; never write conversations.
export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN;
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token);
  const read = async (route: string) => {
    const response = await fetch(`${origin}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `READ_HTTP_${response.status}`);
    return response.json();
  };
  const catalog = await read('/api/bots?shape=agents');
  const agent = (catalog.agents || catalog.bots || []).find((item: {id: string}) => item.id === 'agent-1786843330392-emdjv2');
  assert.ok(agent);
  const history = await read('/api/conversations/history');
  const conversations = history.conversations.filter((item: {agent_id: string}) => item.agent_id === agent.id).slice(0, 10);
  const results = [];
  for (const item of conversations) {
    const data = await read(`/api/conversations/history?id=${encodeURIComponent(item.id)}`);
    const messages = data.conversation.messages.map((message: {created_at: string}) => ({ ...message, timestamp: Date.parse(message.created_at) }));
    for (const message of messages.filter((entry: {role: string}) => entry.role === 'assistant').slice(-2)) {
      const intake = readStoryboardIntakeSnapshotForMessage(messages, message.id, 'high_energy');
      const contract = resolveStoryboardHandoffContract(messages, message.id, agent.output_style);
      const parsed = parseStructuredAgentOutput(message.content, true, { expectedInput: intake?.input, requirePerformancePlan: contract.requirePerformancePlan });
      const detail = !contract.error && buildHomepageStoryboardDraftDetail(message, intake?.input, contract.requiredVersion,
        {previewAssetVerification: true, referenceProjectId: intake?.referenceProjectId, allowLegacyUnverified: contract.allowLegacyUnverified, requirePerformancePlan: contract.requirePerformancePlan});
      const draft = !detail && buildHistoricalStoryboardMessageDraft(message, messages, intake?.input, agent.output_style, contract.allowLegacyUnverified === true && !contract.requirePerformancePlan);
      if (process.argv.includes('--screenshot-match') && message.content.includes('狗老了之后')) {
        console.log(JSON.stringify({screenshotCandidate: item.id, messageId: message.id,
          input: intake?.input, segments: parsed.status === 'valid' ? parsed.segments.length : 0,
          visibleHead: message.content.slice(0, 2400), visibleTail: message.content.split('<!--')[0].slice(-1800)}, null, 2));
      }
      if (process.argv.includes('--inspect-fields') && item.id === 'local_1792611325137_wnr81y' && parsed.status === 'valid') {
        const pkg = parsed.machine_payload as StoryboardDirectorPackage;
        console.log(JSON.stringify({ headers: [...message.content.matchAll(/(^|\n)(`{3,})(?:text|txt|prompt)?[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/gi)].map(match => message.content.slice(Math.max(0, match.index! - 180), match.index!)),
          segmentCounts: { original: intake?.input.segmented_script.split('\n').length, echoed: pkg?.segments?.length } }, null, 2));
      }
      results.push({ conversationId: item.id, messageId: message.id, createdAt: message.created_at,
        characters: message.content.length, marker: message.content.match(/<!--\s*storyboard_[^\s{]+/u)?.[0],
        codeBlocks: (message.content.match(/```/gu) || []).length / 2,
        hasIntake: Boolean(intake), mode: intake?.input.visual_asset_mode, contract,
        status: parsed.status, source: 'source' in parsed ? parsed.source : undefined,
        validation: parsed.status === 'valid' && parsed.phase === 'storyboard' ? validateStoryboardDirectorPackage(parsed.machine_payload as StoryboardDirectorPackage, intake?.input, { stage: 'planning', allowLegacyMissingChoices: contract.allowLegacyUnverified }) : undefined,
        errors: 'errors' in parsed ? parsed.errors : undefined,
        phase: 'phase' in parsed ? parsed.phase : undefined, canBuildDetail: Boolean(detail), canImportHistoricalDraft: Boolean(draft && parseLegacyStoryboardDraftImport(draft)) });
    }
  }
  const report = { checkedAt: new Date().toISOString(), scope: 'owner-scoped read-only local conversation diagnostics', writes: 0, results };
  const directory = '.codex-evidence/director-refinement-20261023/continuous-followup';
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(`${directory}/handoff-readonly.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
