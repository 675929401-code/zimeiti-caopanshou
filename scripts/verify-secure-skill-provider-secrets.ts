import assert from "node:assert/strict";
import { createProviderSecretResolver } from "../src/lib/provider-secret";

const aliases: Record<string, string> = {
  "secure-skill-flow-omni": "SECURE_SKILL_FLOW_OMNI_API_KEY",
  "secure-skill-flow-omni-video-edit": "SECURE_SKILL_FLOW_OMNI_VIDEO_EDIT_API_KEY",
  "secure-skill-flow-veo-i2v-lite": "SECURE_SKILL_FLOW_VEO_I2V_LITE_API_KEY",
  "secure-skill-flow-veo-i2v-fast": "SECURE_SKILL_FLOW_VEO_I2V_FAST_API_KEY",
  "secure-skill-flow-veo-interpolation-lite": "SECURE_SKILL_FLOW_VEO_INTERPOLATION_LITE_API_KEY",
  "secure-skill-flow-veo-r2v-fast": "SECURE_SKILL_FLOW_VEO_R2V_FAST_API_KEY",
  "secure-skill-flow-veo-t2v-fast": "SECURE_SKILL_FLOW_VEO_T2V_FAST_API_KEY",
  "secure-skill-flow-veo-t2v-lite": "SECURE_SKILL_FLOW_VEO_T2V_LITE_API_KEY",
  "secure-skill-grok-video": "SECURE_SKILL_GROK_VIDEO_API_KEY",
  "secure-skill-grok-video-1-5-preview": "SECURE_SKILL_GROK_VIDEO_1_5_PREVIEW_API_KEY",
  "secure-skill-seedance-official-token": "SECURE_SKILL_SEEDANCE_OFFICIAL_TOKEN_API_KEY",
  "secure-skill-seedance-video": "SECURE_SKILL_SEEDANCE_VIDEO_API_KEY",
  "secure-skill-video-enterprise": "SECURE_SKILL_VIDEO_ENTERPRISE_API_KEY",
  "secure-skill-minimax-h3-ecommerce": "SECURE_SKILL_MINIMAX_H3_ECOMMERCE_API_KEY",
  "secure-skill-wan3-video": "SECURE_SKILL_WAN3_VIDEO_API_KEY",
  "secure-skill-wan3-video-prime": "SECURE_SKILL_WAN3_VIDEO_PRIME_API_KEY",
};

const environment: Record<string, string> = {};
for (const [index, envKey] of Object.values(aliases).entries()) {
  environment[envKey] = `fixture-provider-key-${index.toString().padStart(2, "0")}`;
}

const resolver = createProviderSecretResolver({
  environment,
  platform: "linux",
  filePolicy: {
    platform: "linux",
    exists: () => false,
    stat: () => { throw new Error("not used"); },
    readText: () => { throw new Error("not used"); },
    effectiveUserId: () => undefined,
  },
});

for (const [alias, envKey] of Object.entries(aliases)) {
  assert.equal(resolver(`secret://${alias}`), environment[envKey]);
}
assert.throws(() => resolver("secret://secure-skill-unknown"), /未知的本地密钥引用/);

console.log(`Secure Skill provider secret verification: PASS (${Object.keys(aliases).length} isolated aliases)`);
