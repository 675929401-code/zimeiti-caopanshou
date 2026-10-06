"use client";

import { Link2, Scissors, Sparkles, Music, Wand2 } from "lucide-react";

/**
 * 功能演示动画窗（Landing 专用）
 * 每个功能一段纯 CSS 循环演示，样式全部在 landing-fx.css 中，
 * 限定 .landing-page 作用域 + lp 前缀，不影响其他页面。
 * 基础态 = 完成态，prefers-reduced-motion 时定格为完成态。
 */
export type LpDemoKind =
  | "chat"
  | "extract"
  | "segment"
  | "video"
  | "cover"
  | "voice"
  | "format"
  | "more";

// 声波条参数（确定性数组，避免 hydration 问题）
const EQ_DURATIONS = [0.7, 0.9, 0.6, 1.1, 0.8, 1.0, 0.65, 0.95, 0.75, 1.05, 0.85, 0.7];
const EQ_DELAYS = [0, -0.3, -0.6, -0.2, -0.5, -0.8, -0.1, -0.4, -0.7, -0.25, -0.55, -0.45];

export function LpDemo({ kind }: { kind: LpDemoKind }) {
  switch (kind) {
    // 1. AI 智能体对话：提问气泡 → 输入中 → 流式回答
    case "chat":
      return (
        <div className="lp-demo" aria-hidden="true">
          <div className="lpdc-q">写一条爆款文案</div>
          <div className="lpdc-typing">
            <i />
            <i />
            <i />
          </div>
          <div className="lpdc-a">
            <b className="l1" />
            <b className="l2" />
          </div>
        </div>
      );
    // 2. 文案提取：链接 → 提取光束 → 文案行逐条出现
    case "extract":
      return (
        <div className="lp-demo" aria-hidden="true">
          <div className="lpde-link">
            <Link2 className="w-2.5 h-2.5" />
            <span>video/7xK…</span>
          </div>
          <div className="lpde-beam" />
          <div className="lpde-lines">
            <b className="l1" />
            <b className="l2" />
            <b className="l3" />
          </div>
        </div>
      );
    // 3. 智能分段：剪刀扫过 → 整段文案拆成分段
    case "segment":
      return (
        <div className="lp-demo" aria-hidden="true">
          <div className="lpds-block">
            <b className="l1" />
            <b className="l2" />
            <b className="l3" />
          </div>
          <div className="lpds-cut">
            <Scissors className="w-2.5 h-2.5" />
          </div>
        </div>
      );
    // 4. 视频制作：播放头扫过时间轴，片段依次点亮
    case "video":
      return (
        <div className="lp-demo" aria-hidden="true">
          <div className="lpdv-clips">
            <span className="c1">
              <u />
            </span>
            <span className="c2">
              <u />
            </span>
            <span className="c3">
              <u />
            </span>
          </div>
          <div className="lpdv-head" />
        </div>
      );
    // 5. 封面设计：渐变渲染扫入画框 → 星光闪现
    case "cover":
      return (
        <div className="lp-demo" aria-hidden="true">
          <div className="lpcv-frame">
            <div className="lpcv-fill" />
            <Sparkles className="lpcv-spark" />
          </div>
        </div>
      );
    // 6. 智音工坊：声波均衡器律动
    case "voice":
      return (
        <div className="lp-demo" aria-hidden="true">
          <Music className="lpdvs-ic" />
          <div className="lpdvs-bars">
            {EQ_DURATIONS.map((d, i) => (
              <b key={i} style={{ animationDuration: `${d}s`, animationDelay: `${EQ_DELAYS[i]}s` }} />
            ))}
          </div>
        </div>
      );
    // 7. 内容格式化：杂乱文本 → 魔棒一挥 → 整齐排版
    case "format":
      return (
        <div className="lp-demo" aria-hidden="true">
          <div className="lpdf-messy">
            <b className="m1" />
            <b className="m2" />
            <b className="m3" />
          </div>
          <Wand2 className="lpdf-wand" />
          <div className="lpdf-tidy">
            <b className="t1" />
            <b className="t2" />
            <b className="t3" />
          </div>
        </div>
      );
    // 8. 更多功能：环绕光点 + 星光脉动
    case "more":
      return (
        <div className="lp-demo" aria-hidden="true">
          <div className="lpdm-orbit">
            <i className="o1" />
            <i className="o2" />
            <i className="o3" />
          </div>
          <Sparkles className="lpdm-core" />
        </div>
      );
    default:
      return null;
  }
}
