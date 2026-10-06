import { mkdir, writeFile } from "node:fs/promises";
import { BORDER_COLLIE_HOME_SCRIPT } from "../src/lib/canvas-demo-scripts";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputPath = ".tmp-e2e/storyboard-compiler-diagnostics.json";

type CompilerDiagnostic = {
  model: string;
  stage: string;
  status: "accepted" | "rejected" | "failed";
  durationMs: number;
  detail?: string;
};

const DANGLING_PROMPT_FRAGMENT_PATTERN = /(?:但|并且|以及|或者|把|被|由|将|仅用于)…/u;
const GRAPHIC_FORM_PATTERN = /(?:图标|符号|轮廓|线|辉线|光带|光弧|波纹|涟漪|心脏|心跳|冷汗|问号|感叹号|旋风|轨迹|形状|剪影|气泡|粒子|箭头)/u;
const GRAPHIC_POSITION_PATTERN = /(?:左|右|上方|下方|旁|附近|周围|胸口|胸前|胸腔|耳后|头顶|边缘|前景|中景|背景|画面|身后|后方|门后|门边|前方|侧面|脸侧|脸部|面部|眼前|眼周|身侧|脚边|贴地|探头处|所在区域|路径)/u;
const GRAPHIC_BINDING_PATTERN = /(?:绑定|贴附|围绕|沿|朝|指向|跟随|位于|悬浮|环绕|收束|连接|从.+延伸)/u;

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  if (!sessionResponse.ok || !session.token) {
    throw new Error(session.error || "本地开发会话不可用");
  }

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/canvas/compile-script`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      script: BORDER_COLLIE_HOME_SCRIPT,
      presetId: "anime_story",
      style: "电影级3D卡通半写实动画，欧美家庭动画电影质感，剧情化表演，角色不说话",
      ratio: "16:9",
      referenceMode: "single",
      keyframeStrategy: "visual-anchor",
      effectsLevel: "rich",
      productionMode: "anime-story",
      assistantInstruction: "先分析全文的情绪、节奏、角色和演绎策略；每镜根据当前语义决定表演、道具、环境反馈与图形强化，不为了装饰而装饰；角色不说话；只保留现场环境音与动作音。",
      allowDurationTrim: true,
      videoModelDurationMode: "fixed",
      videoModelDurationSeconds: 8,
    }),
  });
  const result = await response.json() as {
    error?: string;
    compiler?: "ai" | "deterministic-fallback";
    compilerDiagnostics?: CompilerDiagnostic[];
    qualityNotes?: string[];
    characterAssets?: Array<{ id: string; name: string }>;
    semanticSegments?: Array<{ order: number; narration: string }>;
    shots?: Array<{
      order: number;
      visualMode: "narrative" | "hybrid-packaging" | "semantic-cutaway";
      effectsPrompt: string;
      imagePrompt: string;
      videoPrompt: string;
    }>;
  };
  if (!response.ok) throw new Error(result.error || `编译接口返回 ${response.status}`);

  const architectureFailures: string[] = [];
  if (result.compiler !== "ai") {
    architectureFailures.push("分镜编译未使用完整AI计划，不能以本地降级结果冒充验收通过");
  }
  if (!(result.compilerDiagnostics || []).some((item) => item.stage === "global-shot-plan" && item.status === "accepted")) {
    architectureFailures.push("全局分析没有一次性锁定完整逐镜决策表");
  }
  const graphics = (result.shots || []).map((shot) => ({
    order: shot.order,
    graphics: shot.effectsPrompt.match(/【图形特效】([^【]*)/u)?.[1]?.trim() || "未找到图形特效字段",
  }));
  const failures = (result.shots || []).flatMap((shot) => {
    const graphicDirection = shot.effectsPrompt.match(/【图形特效】([^【]*)/u)?.[1]?.trim() || "";
    const hasGraphic = Boolean(graphicDirection) && !/^(?:无|不使用|不添加|不需要)/u.test(graphicDirection);
    const shotFailures: string[] = [...(shot.order === 1 ? architectureFailures : [])];
    if (shot.visualMode !== "narrative" && !hasGraphic) {
      shotFailures.push(`分镜${shot.order}声明${shot.visualMode}但缺少可执行图形包装`);
    }
    if (DANGLING_PROMPT_FRAGMENT_PATTERN.test(shot.imagePrompt)) {
      shotFailures.push(`分镜${shot.order}生图提示词存在被截断的半句话`);
    }
    if (!/(?:镜头表达|模式)：/u.test(shot.imagePrompt)) {
      shotFailures.push(`分镜${shot.order}生图提示词没有写明参考图表达模式`);
    }
    if (shot.visualMode === "hybrid-packaging") {
      const packagedEvidence = shot.imagePrompt.match(/必画语义证据（优先执行）：([\s\S]*?)(?=\n静态画面：|$)/u)?.[1] || "";
      if (!GRAPHIC_FORM_PATTERN.test(packagedEvidence)) {
        shotFailures.push(`分镜${shot.order}语义包装没有写清可见形态`);
      }
      if (!GRAPHIC_POSITION_PATTERN.test(packagedEvidence)) {
        shotFailures.push(`分镜${shot.order}语义包装没有写清画面位置`);
      }
      if (!GRAPHIC_BINDING_PATTERN.test(packagedEvidence)) {
        shotFailures.push(`分镜${shot.order}语义包装没有写清主体绑定或指向关系`);
      }
    }
    if (!shot.videoPrompt.includes("@参考图1") || !shot.videoPrompt.includes("不得绕过参考图")) {
      shotFailures.push(`分镜${shot.order}视频提示词没有强制绑定上游参考图`);
    }
    return shotFailures;
  });
  const visualModeCounts = Object.fromEntries(["narrative", "hybrid-packaging", "semantic-cutaway"].map((mode) => [
    mode,
    (result.shots || []).filter((shot) => shot.visualMode === mode).length,
  ]));
  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ...result,
    summary: {
      compiler: result.compiler,
      characters: result.characterAssets?.map((character) => character.name) || [],
      segments: result.semanticSegments?.length || 0,
      shots: result.shots?.length || 0,
      graphicDirections: graphics,
      visualModeCounts,
      failures,
    },
  };
  await mkdir(".tmp-e2e", { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    durationMs: report.durationMs,
    compiler: report.summary.compiler,
    characters: report.summary.characters,
    segments: report.summary.segments,
    shots: report.summary.shots,
    diagnostics: result.compilerDiagnostics || [],
    graphicDirections: graphics,
    visualModeCounts,
    failures,
    outputPath,
  }, null, 2));
  if (failures.length > 0) throw new Error(`分镜参考图链路质检失败：${failures.join("；")}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
