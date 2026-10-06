#!/usr/bin/env node

import crypto from "node:crypto";
import https from "node:https";

const PROD_BASE = process.env.PRODUCTION_SITE_URL || "https://zyuani8.com";
const JWT_SECRET = process.env.JWT_SECRET?.trim() ?? '';
const APPLY = process.argv.includes("--apply");

function base64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function createAdminToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    userId: "local-production-sync",
    username: "local-production-sync",
    role: "admin",
    displayName: "Local Production Sync",
    iat: now,
    exp: now + 600,
  };
  const unsigned = `${base64url(header)}.${base64url(payload)}`;
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function request(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  const token = createAdminToken();
  return new Promise((resolve, reject) => {
    const req = https.request(`${PROD_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {}),
      },
      timeout: 45000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {}
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }
        reject(new Error(`${method} ${path} failed: ${res.statusCode} ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`));
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function modelByDisplayName(models, name) {
  const hit = models.find((model) => model.name === name && model.model_type === "text" && model.is_active !== false);
  if (!hit) throw new Error(`Model not found: ${name}`);
  return hit;
}

const PROFILE_DEFS = {
  claude_sonnet_b: {
    modelDisplayName: "claude-sonnet-4-6 渠道B",
    patch: {
      timeout: 120,
      max_reply_tokens: 8192,
      deep_thinking_type: 0,
      deduct_deep_think: 1,
      image_parsing: "none",
      file_parsing: "none",
    },
  },
  claude_opus_b_default: {
    modelDisplayName: "claude-opus-4-8 渠道B default",
    patch: {
      timeout: 180,
      max_reply_tokens: 8192,
      deep_thinking_type: 0,
      deduct_deep_think: 1,
      image_parsing: "auto",
      file_parsing: "auto",
    },
  },
  gpt56_terra_a: {
    modelDisplayName: "GPT-5.6-Terra · 渠道A",
    patch: {
      timeout: 180,
      max_reply_tokens: 12288,
      deep_thinking_type: 0,
      deduct_deep_think: 1,
      image_parsing: "none",
      file_parsing: "none",
    },
  },
  deepseek_flash_official: {
    modelDisplayName: "DeepSeek-V4-Flash (官方直连)",
    patch: {
      timeout: 120,
      max_reply_tokens: 8192,
      deep_thinking_type: 0,
      deduct_deep_think: 1,
      image_parsing: "none",
      file_parsing: "none",
    },
  },
};

const AGENT_ROUTING = [
  {
    profile: "claude_opus_b_default",
    names: [
      "2D文案影像架构师",
      "2D文案影像架构师 (升级)",
      "3D多模态需搭配参考图",
      "3D文案影像架构师",
      "3D文案影像架构师 (升级)",
      "参考图生成",
      "故事脚本架构",
      "AI智能体品牌形象设计师",
    ],
  },
  {
    profile: "claude_sonnet_b",
    names: [
      "百事通",
      "爆单文案重构师",
      "爆款裂变选题",
      "爆款文案重构师",
      "宠物赛道口播策划助手",
      "带货营销助手",
      "抖音爆点钩子专家 v4.0",
      "泛流量选题师",
      "盖瓦小玲子智能体",
      "门店获客引擎",
      "命理星盘解码",
      "人群画像洞察",
      "赛道爆文嫁接师",
      "赛道爆文嫁接师2拆解版",
      "三维成交引擎",
      "实体号起盘师",
      "实体搜索霸屏",
      "文案质检专家",
      "象限选题军师",
      "心理学用户洞察",
      "知识爆款铸造",
      "SEO标题封面制作",
      "AI品牌铸造",
    ],
  },
  {
    profile: "gpt56_terra_a",
    names: [
      "抖音原文案提取助手",
      "逆向拆解猎手",
      "造课编排以运营",
      "智能体产品经理",
      "智能体工程开发师3.0",
      "智能体工程开发系统 4.0",
      "智能体工程开师 5.0",
      "智能体价值包装师",
      "智能体说明书",
      "AI产品架构师",
      "Prompt工程师",
    ],
  },
  {
    profile: "deepseek_flash_official",
    names: [
      "JSON表单生成器",
    ],
  },
];

function routingMap() {
  const map = new Map();
  for (const group of AGENT_ROUTING) {
    for (const name of group.names) {
      map.set(name, group.profile);
    }
  }
  return map;
}

async function main() {
  const [modelsPayload, agentsPayload] = await Promise.all([
    request("GET", "/api/admin/models"),
    request("GET", "/api/admin/agents"),
  ]);

  const models = modelsPayload.models || [];
  const agents = (agentsPayload.agents || []).filter((agent) => !agent.deleted_at);
  const routeMap = routingMap();

  const profiles = Object.fromEntries(
    Object.entries(PROFILE_DEFS).map(([key, def]) => {
      const model = modelByDisplayName(models, def.modelDisplayName);
      return [key, { ...def, model }];
    }),
  );

  const updates = [];
  const skipped = [];

  for (const agent of agents) {
    const profileKey = routeMap.get(agent.name);
    if (!profileKey) {
      skipped.push({ agent: agent.name, reason: "no-routing-rule" });
      continue;
    }

    const profile = profiles[profileKey];
    const next = {
      agentId: agent.id,
      model: profile.model.model_name,
      model_id: profile.model.id,
      ...profile.patch,
    };

    const unchanged =
      agent.model === next.model &&
      agent.model_id === next.model_id &&
      (agent.timeout ?? null) === next.timeout &&
      (agent.max_reply_tokens ?? null) === next.max_reply_tokens &&
      (agent.deep_thinking_type ?? null) === next.deep_thinking_type &&
      (agent.deduct_deep_think ?? null) === next.deduct_deep_think &&
      (agent.image_parsing ?? null) === next.image_parsing &&
      (agent.file_parsing ?? null) === next.file_parsing;

    if (unchanged) {
      skipped.push({ agent: agent.name, reason: "already-matched" });
      continue;
    }

    updates.push({
      agentId: agent.id,
      agentName: agent.name,
      profile: profileKey,
      from: {
        model: agent.model,
        model_id: agent.model_id,
      },
      to: {
        model: next.model,
        model_id: next.model_id,
      },
      payload: next,
    });
  }

  console.log(`Mode: ${APPLY ? "apply" : "dry-run"}`);
  console.log(`Matched updates: ${updates.length}`);
  console.log(`Skipped: ${skipped.length}`);
  for (const item of updates) {
    console.log(`- ${item.agentName}: ${item.from.model || "unknown"} -> ${item.to.model} (${item.profile})`);
  }

  if (!APPLY) {
    if (skipped.length) {
      console.log("\nSkipped:");
      for (const item of skipped) {
        console.log(`- ${item.agent}: ${item.reason}`);
      }
    }
    return;
  }

  for (const item of updates) {
    await request("PUT", "/api/admin/agents", item.payload);
  }

  console.log(`\nApplied ${updates.length} agent updates successfully.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
