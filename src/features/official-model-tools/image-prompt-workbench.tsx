"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { Check, Copy, ImageIcon, LoaderCircle, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useApp } from "@/contexts/app-context";
import styles from "./official-model-tools.module.css";

type DetailLevel = "concise" | "standard" | "detailed";

interface ImagePromptResult {
  title?: string;
  promptZh?: string;
  promptEn?: string;
  negativePrompt?: string;
  suggestedRatio?: string;
  text?: string;
}

const DETAIL_OPTIONS: Array<{ id: DetailLevel; label: string; note: string }> = [
  { id: "concise", label: "简洁", note: "一句话提示词" },
  { id: "standard", label: "标准", note: "结构化提示词（推荐）" },
  { id: "detailed", label: "详细", note: "完整分析与双语提示词" },
];

export function ImagePromptWorkbench() {
  const { state } = useApp();
  const [theme, setTheme] = useState("");
  const [style, setStyle] = useState("自动选择 · 根据主题匹配风格");
  const [detail, setDetail] = useState<DetailLevel>("standard");
  const [result, setResult] = useState<ImagePromptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const displayPrompt = useMemo(() => {
    if (!result) return "";
    return [
      result.promptZh || result.text || "",
      result.promptEn ? `English\n${result.promptEn}` : "",
      result.negativePrompt ? `负面提示词\n${result.negativePrompt}` : "",
      result.suggestedRatio ? `建议比例：${result.suggestedRatio}` : "",
    ].filter(Boolean).join("\n\n");
  }, [result]);

  async function generatePrompt() {
    if (!theme.trim() || loading) return;
    if (!state.auth.token) {
      setError("请先登录，再生成提示词。");
      return;
    }
    setLoading(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch("/api/tools/creative-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.auth.token}`,
        },
        body: JSON.stringify({
          operation: "image-prompt",
          input: {
            theme: theme.trim(),
            style,
            detail,
            targetModel: "已启用生图模型",
          },
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        result?: ImagePromptResult;
      };
      if (!response.ok || !payload.result) {
        throw new Error(payload.error || `提示词生成失败（${response.status}）`);
      }
      setResult(payload.result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提示词生成失败");
    } finally {
      setLoading(false);
    }
  }

  async function copyResult() {
    if (!displayPrompt) return;
    await navigator.clipboard.writeText(displayPrompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <main className={styles.page} data-testid="image-prompt-workbench">
      <Link className={styles.backLink} href="/tools/text">← 返回文本创作</Link>
      <header className={styles.hero}>
        <h1><Search size={32} aria-hidden="true" /> 图片提示词生成</h1>
        <p>输入主题，AI 将生成结构化中英文生图提示词。</p>
      </header>

      <div className={styles.modeTabs}>
        <button className={styles.modeTab} data-active="true" type="button">
          <Sparkles size={18} />
          <span><strong>从主题生成</strong><small>输入主题，AI 生成提示词</small></span>
        </button>
        <button className={styles.modeTab} disabled type="button" title="即将上线">
          <ImageIcon size={18} />
          <span><strong>从图片反推</strong><small>即将上线</small></span>
        </button>
      </div>

      <section className={styles.workspaceGrid}>
        <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); void generatePrompt(); }}>
          <h2><span className={styles.panelIcon}><Sparkles size={17} /></span> 主题设置</h2>
          <label className={styles.fieldLabel} htmlFor="image-prompt-theme">画面描述 <em>*</em></label>
          <textarea
            id="image-prompt-theme"
            maxLength={4_000}
            onChange={(event) => setTheme(event.target.value)}
            placeholder="描述你想画的画面，例如：赛博朋克风格的未来城市，霓虹灯闪烁的雨夜街道……"
            rows={6}
            value={theme}
          />

          <label className={styles.fieldLabel} htmlFor="image-prompt-style">艺术风格</label>
          <select id="image-prompt-style" onChange={(event) => setStyle(event.target.value)} value={style}>
            <option>自动选择 · 根据主题匹配风格</option>
            <option>商业级 3D 动画</option>
            <option>电影感写实</option>
            <option>国风插画</option>
            <option>日系动画</option>
            <option>黏土定格</option>
          </select>

          <span className={styles.fieldLabel}>详细程度</span>
          <div className={styles.segmented}>
            {DETAIL_OPTIONS.map((option) => (
              <button
                data-active={detail === option.id ? "true" : undefined}
                key={option.id}
                onClick={() => setDetail(option.id)}
                type="button"
              >
                <strong>{option.label}</strong>
                <small>{option.note}</small>
              </button>
            ))}
          </div>

          <div className={styles.statusLine}>
            <span>执行模型：AI 文案模型</span>
            <span>输出目标：图片创作工作台</span>
          </div>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <button className={styles.primaryButton} disabled={!theme.trim() || loading} type="submit">
            {loading ? <LoaderCircle className={styles.spinner} size={18} /> : <Sparkles size={18} />}
            {loading ? "正在生成" : "生成提示词"}
          </button>
        </form>

        <section className={styles.panel}>
          <div className={styles.panelHeadingRow}>
            <h2><span className={styles.panelIcon}><ImageIcon size={17} /></span> 生成结果</h2>
            {displayPrompt ? (
              <button className={styles.copyButton} onClick={() => void copyResult()} type="button">
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? "已复制" : "复制"}
              </button>
            ) : null}
          </div>
          {displayPrompt ? (
            <div className={styles.resultBox}>
              {result?.title ? <h3>{result.title}</h3> : null}
              <pre>{displayPrompt}</pre>
              <Link className={styles.secondaryButton} href="/tools/image/image-chat">进入图片创作</Link>
            </div>
          ) : (
            <div className={styles.emptyResult}>
              <span><Sparkles size={26} /></span>
              <strong>输入主题并点击“生成提示词”</strong>
              <small>支持中文、英文和负面提示词结构化输出。</small>
            </div>
          )}
        </section>
      </section>

      <section className={styles.guide}>
        <h2>提示词结构</h2>
        <div className={styles.formula}>
          <span>主体</span><b>+</b><span>行为</span><b>+</b><span>环境</span><b>+</b><span>风格</span><b>+</b><span>光线</span><b>+</b><span>构图</span>
        </div>
      </section>
    </main>
  );
}
