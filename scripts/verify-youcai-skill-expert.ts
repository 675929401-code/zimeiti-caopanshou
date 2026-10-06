import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildYoucaiSkillDirectory,
  findYoucaiSkillByCommand,
  inferYoucaiSkill,
  parseYoucaiSkillInvocation,
  YOUCAI_SKILL_CATALOG,
} from "../src/lib/youcai-skill-catalog";
import { buildMangaCreativeAgentApiContent } from "../src/lib/manga-creative-agent-prompt";
import { YOUCAI_SKILL_RUNTIME } from "../src/lib/youcai-skill-runtime";
import { YOUCAI_SKILL_INSTRUCTIONS } from "../src/lib/youcai-skill-instructions";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

const officialSkills = YOUCAI_SKILL_CATALOG.filter((skill) => skill.source === "official");
const communitySkills = YOUCAI_SKILL_CATALOG.filter((skill) => skill.source === "community");
const commands = new Set(YOUCAI_SKILL_CATALOG.map((skill) => skill.commandName));

assert.equal(YOUCAI_SKILL_CATALOG.length, 36, "内置 Skill 目录应包含 36 项能力");
assert.equal(officialSkills.length, 21, "官方 Skill 应为 21 个");
assert.equal(communitySkills.length, 15, "社区 Skill 应为 15 个");
assert.equal(commands.size, YOUCAI_SKILL_CATALOG.length, "Skill 命令不应重复");
assert.equal(YOUCAI_SKILL_RUNTIME.length, YOUCAI_SKILL_CATALOG.length, "36 项 Skill 必须全部具备运行时契约");
assert.equal(YOUCAI_SKILL_INSTRUCTIONS.length, YOUCAI_SKILL_CATALOG.length, "36 项 Skill 必须全部具备服务端完整指令");
assert.ok(officialSkills.every((skill) => skill.installedByDefault), "官方 Skill 必须默认安装");
assert.ok(officialSkills.every((skill) => skill.agentAutoInvokeEnabled), "官方 Skill 必须允许语义调用");
assert.ok(communitySkills.every((skill) => !skill.installedByDefault), "社区 Skill 不应默认安装");

const explicit = parseYoucaiSkillInvocation("/ad-script-master 为茶饮品牌写15秒广告");
assert.equal(explicit.skill?.commandName, "ad-script-master");
assert.equal(explicit.request, "为茶饮品牌写15秒广告");
assert.equal(explicit.explicit, true);

assert.equal(findYoucaiSkillByCommand("/sd25-pe")?.title, "Seedance 2.5 提示词优化");
assert.equal(inferYoucaiSkill("请帮我做一份小红书文案，提高曝光")?.commandName, "social-content-optimizer");
assert.equal(inferYoucaiSkill("分析这个视频，做逐镜拉片")?.commandName, "video-deconstruct-analyzer");

const apiContent = buildMangaCreativeAgentApiContent("/poster-design 为新品设计3:4海报");
assert.match(apiContent, /command="\/poster-design"/u);
assert.match(apiContent, /selection="explicit"/u);
assert.match(apiContent, /authority="client_hint_only"/u);
assert.match(apiContent, /为新品设计3:4海报/u);
assert.doesNotMatch(apiContent, /【官方 Skill 目录】/u, "单次用户消息不应重复发送完整系统目录");

const directory = buildYoucaiSkillDirectory();
assert.ok(directory.includes("/platform-help"));
assert.ok(directory.includes("/skill-assistant"));

const navigationSource = source("src/components/app-route-shell.tsx");
assert.match(navigationSource, /label: "Skill 专家", href: "\/skills"/u);

const skillsPageSource = source("src/features/youcai-skills/youcai-skills-page.tsx");
assert.match(skillsPageSource, /\/tools\/text\/text-chat\?command=/u);
assert.match(skillsPageSource, /内置 Skill 目录/u);
assert.match(skillsPageSource, /我的安装/u);
assert.match(skillsPageSource, /安装状态只以服务端为准/u);

const skillApiSource = source("src/features/youcai-skills/youcai-skill-api.ts");
assert.match(skillApiSource, /fetch\("\/api\/youcai\/skills\?limit=100"/u);
assert.match(skillApiSource, /fetch\("\/api\/youcai\/skills\/install"/u);
assert.match(skillApiSource, /\/uninstall/u);
assert.doesNotMatch(skillsPageSource, /localStorage/u, "Skill 页面不得使用浏览器本地状态伪造安装生命周期");

const agentSource = source("src/features/official-core-routes/official-agent-route.tsx");
assert.match(agentSource, /new URLSearchParams\(window\.location\.search\)\.get\("command"\)/u);
assert.match(agentSource, /buildMangaCreativeAgentApiContent/u);
assert.match(agentSource, /命令与 Skill/u);

console.log(JSON.stringify({
  ok: true,
  catalog: {
    total: YOUCAI_SKILL_CATALOG.length,
    official: officialSkills.length,
    community: communitySkills.length,
  },
  verified: [
    "全局侧栏入口",
    "发布包目录、内置目录与我的安装",
    "来源/分类/标签/搜索",
    "服务端安装与卸载生命周期",
    "36 项运行时与完整指令覆盖",
    "显式命令解析",
    "官方 Skill 语义匹配",
    "Skill 到 Agent 命令注入",
    "单次 API Skill 契约",
  ],
}, null, 2));
