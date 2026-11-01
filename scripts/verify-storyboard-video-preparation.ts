import assert from "node:assert/strict";
import { prepareStoryboardVideo } from "../src/lib/storyboard-video-preparation";

async function main() {
  let checks = 0;
  for (const outcome of ["owned", "saved", "save-failed", "project-save-failed", "changed-account", "changed-prompt", "cancel-confirmation"] as const) {
    const locks = new Set<string>();
    let identity = "owner-A/run/card/record/original-parameters";
    let saves = 0, confirmations = 0, providerCalls = 0;
    const phases: boolean[] = [];
    const run = prepareStoryboardVideo({ cardId: "card", locks, identity: () => identity,
      needsSave: outcome !== "owned",
      save: async () => {
        saves++;
        if (outcome === "changed-account" || outcome === "changed-prompt") identity = outcome;
        return outcome !== "save-failed" && outcome !== "project-save-failed";
      },
      submit: async () => { confirmations++; if (outcome !== "cancel-confirmation") providerCalls++; return "result"; },
      onPreparing: value => phases.push(value),
    });
    if (outcome === "changed-account" || outcome === "changed-prompt") await assert.rejects(run, /已改变/u);
    else await run;
    assert.equal(saves, outcome === "owned" ? 0 : 1);
    const blocked = ["save-failed", "project-save-failed", "changed-account", "changed-prompt"].includes(outcome);
    assert.equal(confirmations, blocked ? 0 : 1);
    assert.equal(providerCalls, blocked || outcome === "cancel-confirmation" ? 0 : 1);
    assert.equal(locks.size, 0);
    assert.deepEqual(phases, [true, false]);
    checks++;
  }
  const locks = new Set<string>();
  let release!: () => void;
  const saved = new Promise<boolean>(resolve => { release = () => resolve(true); });
  let submits = 0, saves = 0;
  const input = { cardId: "card", locks, identity: () => "stable", needsSave: true,
    save: () => { saves++; return saved; }, submit: async () => { submits++; return "result"; }, onPreparing: () => {},
  };
  const first = prepareStoryboardVideo(input);
  assert.equal(await prepareStoryboardVideo(input), null);
  assert.equal(saves, 1); assert.equal(submits, 0);
  release(); await first;
  assert.equal(submits, 1); assert.equal(locks.size, 0); checks++;
  await assert.rejects(prepareStoryboardVideo({ ...input, locks: new Set(), save: async () => { throw new Error("storage unavailable"); } }), /storage unavailable/u);
  checks++;
  console.log(JSON.stringify({ passed: checks, failed: 0, scope: "one click save/submit orchestration; cancellation, save failures, changed scope, duplicate click", actualProviderRequests: 0, databaseWrites: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
