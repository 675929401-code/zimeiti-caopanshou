import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";
import {
  configuredStoryboardPromptPushCapability,
  hasStoryboardPromptPushCapability,
  setStoryboardPromptPushCapability,
} from "../src/lib/storyboard-prompt-push-capability";
import { publicStoryboardDirectorOutputStyle } from "../src/lib/storyboard-director-public-output-style";

const checks: string[] = [];
function check(name: string, fn: () => void) {
  fn();
  checks.push(name);
}

check("legacy official directors keep the handoff icon when the new field is absent", () => {
  assert.equal(hasStoryboardPromptPushCapability(STORY_DIRECTOR_MOVIE_AGENT_ID, {}), true);
  assert.equal(hasStoryboardPromptPushCapability(STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, undefined), true);
});

check("an explicit false disables the icon even for an official director", () => {
  const style = { storyboardPromptHandoff: { enabled: false }, private_style: "kept" };
  assert.equal(hasStoryboardPromptPushCapability(STORY_DIRECTOR_MOVIE_AGENT_ID, style), false);
  assert.equal(configuredStoryboardPromptPushCapability(style), false);
});

check("ordinary agents stay hidden by default and become eligible only after the explicit toggle", () => {
  assert.equal(hasStoryboardPromptPushCapability("ordinary-agent", {}), false);
  const enabled = setStoryboardPromptPushCapability({ fontSize: 16 }, true);
  assert.equal(hasStoryboardPromptPushCapability("ordinary-agent", enabled), true);
  assert.equal(configuredStoryboardPromptPushCapability(enabled), true);
  assert.equal((enabled as { fontSize: number }).fontSize, 16);
});

check("malformed capability data never enables a generic agent", () => {
  for (const value of [null, [], "true", { storyboardPromptHandoff: null }, { storyboardPromptHandoff: { enabled: "true" } }]) {
    assert.equal(hasStoryboardPromptPushCapability("ordinary-agent", value), false);
  }
});

check("the public catalog exposes only the controlled capability bit for ordinary agents", () => {
  assert.deepEqual(
    publicStoryboardDirectorOutputStyle("ordinary-agent", { storyboardPromptHandoff: { enabled: true }, private_style: "omit" }),
    { storyboardPromptHandoff: { enabled: true } },
  );
  assert.equal(publicStoryboardDirectorOutputStyle("ordinary-agent", { private_style: "omit" }), undefined);
});

check("the UI and public catalog use the same capability contract", () => {
  const messageItem = readFileSync("src/components/chat/message-item.tsx", "utf8");
  const messageContent = readFileSync("src/components/chat/message-content.tsx", "utf8");
  const adminToggle = readFileSync("src/components/admin/StoryboardPromptPushCapabilityToggle.tsx", "utf8");
  const publicStyle = readFileSync("src/lib/storyboard-director-public-output-style.ts", "utf8");
  assert.match(messageItem, /hasStoryboardPromptPushCapability/);
  assert.match(messageItem, /StructuredStoryboardHandoff/);
  assert.match(messageContent, /hasStoryboardPromptPushCapability/);
  assert.match(adminToggle, /推送分镜提示词/);
  assert.match(adminToggle, /自动识别/);
  assert.match(publicStyle, /STORYBOARD_PROMPT_HANDOFF_KEY/);
});

const report = {
  passed: true,
  checks,
  effects: { networkRequests: 0, databaseReads: 0, databaseWrites: 0, modelRequests: 0 },
  scope: "capability resolver and source contract only; no browser, provider, database, or credential access",
};
console.log(JSON.stringify(report, null, 2));
