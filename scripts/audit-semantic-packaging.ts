import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputPath = ".tmp-e2e/semantic-packaging-audit.json";
const testScript = [
  "边牧把沙发底部咬出一个大洞，听见女主人走近，它立刻僵住，胸口紧张得怦怦直跳。",
  "女主人掀开沙发底布，碎棉、木架和破洞全部露出来，边牧压低耳朵躲开她的视线。",
  "女主人刚弯腰检查，边牧突然绕过茶几冲向门后，快得像一阵小旋风。",
  "等房间安静下来，它又从门边慢慢探出脑袋，确认主人有没有消气。",
].join("");

type CompilerDiagnostic = {
  model: string;
  stage: string;
  status: "accepted" | "rejected" | "failed";
  durationMs: number;
  detail?: string;
};

type Shot = {
  order: number;
  narration: string;
  visualMode: "narrative" | "hybrid-packaging" | "semantic-cutaway";
  effectsPrompt: string;
  imagePrompt: string;
  videoPrompt: string;
};

const DANGLING_PROMPT_FRAGMENT_PATTERN = /(?:但|并且|以及|或者|把|被|由|将|仅用于)…/u;
const GRAPHIC_FORM_PATTERN = /(?:图标|符号|轮廓|线|辉线|光带|光弧|波纹|涟漪|脉冲|心脏|心跳|冷汗|问号|感叹号|旋风|轨迹|形状|剪影|气泡|粒子|箭头)/u;
const GRAPHIC_POSITION_PATTERN = /(?:左|右|上方|下方|旁|附近|周围|胸口|胸前|胸腔|耳后|头顶|边缘|前景|中景|背景|画面|身后|后方|门后|门边|前方|侧面|脸侧|脸部|面部|眼前|眼周|身侧|脚边|贴地|探头处|所在区域|路径)/u;
const GRAPHIC_BINDING_PATTERN = /(?:绑定|贴附|围绕|沿|朝|指向|跟随|位于|悬浮|环绕|收束|连接|从.+延伸)/u;

function requiredEvidence(prompt: string) {
  return prompt.match(/必画语义证据（优先执行）：([\s\S]*?)(?=\n静态画面：|$)/u)?.[1] || "";
}

function hasGraphic(value: string) {
  const graphic = value.match(/【图形特效】([^【]*)/u)?.[1]?.trim() || "";
  return Boolean(graphic) && !/^(?:无|不使用|不添加|不需要)/u.test(graphic);
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  if (!sessionResponse.ok || !session.token) {
    throw new Error(session.error || "本地开发会话不可用");
  }

  const auditRunId = Date.now();
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/canvas/compile-script`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      script: testScript,
      presetId: "anime_story",
      style: "电影级3D卡通半写实动画，欧美家庭动画电影质感，剧情化表演，角色不说话",
      ratio: "16:9",
      referenceMode: "single",
      keyframeStrategy: "visual-anchor",
      effectsLevel: "rich",
      productionMode: "anime-story",
      assistantInstruction: `先分析全文演绎逻辑；每镜自行判断用物理剧情证据、语义图形包装或完整语义可视化。只在语义确有需要时添加，并写清形态、位置、绑定对象和指向关系；不套用固定图标。验收批次：${auditRunId}。`,
      videoModelDurationMode: "fixed",
      videoModelDurationSeconds: 8,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const result = await response.json() as {
    error?: string;
    compiler?: "ai" | "deterministic-fallback";
    compilerRevision?: string;
    compilerDiagnostics?: CompilerDiagnostic[];
    shots?: Shot[];
  };
  if (!response.ok) throw new Error(result.error || `编译接口返回 ${response.status}`);

  const failures: string[] = [];
  const shots = result.shots || [];
  if (result.compiler !== "ai") failures.push("本轮没有使用AI完整规划");
  const hasAcceptedGlobalPlan = (result.compilerDiagnostics || []).some((item) => (
    item.status === "accepted" && (item.stage === "global-shot-plan" || item.stage === "cache-hit")
  ));
  if (!hasAcceptedGlobalPlan) {
    failures.push("全局逐镜导演表没有成功生成");
  }
  for (const shot of shots) {
    const evidence = requiredEvidence(shot.imagePrompt);
    const graphic = hasGraphic(shot.effectsPrompt);
    if (shot.imagePrompt.length > 780) failures.push(`分镜${shot.order}生图提示词超过780字`);
    if (DANGLING_PROMPT_FRAGMENT_PATTERN.test(shot.imagePrompt)) failures.push(`分镜${shot.order}含截断半句`);
    if (shot.visualMode !== "narrative" && !graphic) failures.push(`分镜${shot.order}模式与包装内容矛盾`);
    if (shot.visualMode === "hybrid-packaging") {
      if (!GRAPHIC_FORM_PATTERN.test(evidence)) failures.push(`分镜${shot.order}未写包装可见形态`);
      if (!GRAPHIC_POSITION_PATTERN.test(evidence)) failures.push(`分镜${shot.order}未写包装画面位置`);
      if (!GRAPHIC_BINDING_PATTERN.test(evidence)) failures.push(`分镜${shot.order}未写包装绑定或指向关系`);
    }
    if (!shot.videoPrompt.includes("@参考图1") || !shot.videoPrompt.includes("不得绕过参考图")) {
      failures.push(`分镜${shot.order}视频未绑定对应参考图`);
    }
  }

  const tensionShot = shots.find((shot) => /(?:胸口|怦怦|心跳)/u.test(shot.narration));
  if (!tensionShot) {
    failures.push("没有找到紧张语义分镜");
  } else if (!/(?:心脏|心跳|脉冲|冷汗|压力|紧绷)/u.test(requiredEvidence(tensionShot.imagePrompt))) {
    failures.push(`分镜${tensionShot.order}没有把紧张内在状态转成可见证据`);
  }

  const damageShot = shots.find((shot) => /(?:破洞|碎棉|木架|底布)/u.test(shot.narration));
  if (!damageShot) {
    failures.push("没有找到沙发破损分镜");
  } else if (!/(?:破洞|碎棉|木架|底布)/u.test(requiredEvidence(damageShot.imagePrompt))) {
    failures.push(`分镜${damageShot.order}没有保留沙发破损的物理证据`);
  }

  const speedShot = shots.find((shot) => /(?:旋风|冲向|突然绕过)/u.test(shot.narration));
  if (!speedShot) {
    failures.push("没有找到高速动作分镜");
  } else if (!/(?:旋风|旋流|尾迹|疾冲|速度线|运动轨迹|螺旋|气流|拖影)/u.test(requiredEvidence(speedShot.imagePrompt))) {
    failures.push(`分镜${speedShot.order}没有把高速动作转成可见强化`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    testScript,
    ...result,
    summary: {
      shots: shots.map((shot) => ({
        order: shot.order,
        narration: shot.narration,
        visualMode: shot.visualMode,
        requiredEvidence: requiredEvidence(shot.imagePrompt),
        imagePromptLength: shot.imagePrompt.length,
      })),
      failures,
    },
  };
  await mkdir(".tmp-e2e", { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    durationMs: report.durationMs,
    compiler: result.compiler,
    compilerRevision: result.compilerRevision,
    shots: report.summary.shots,
    diagnostics: result.compilerDiagnostics || [],
    failures,
    outputPath,
  }, null, 2));
  if (failures.length > 0) throw new Error(`语义可视化包装验收失败：${failures.join("；")}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
