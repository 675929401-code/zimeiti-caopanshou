"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { CheckCircle2, LoaderCircle, Music2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "@/contexts/app-context";
import { consumeYoucaiMusicPrefill } from "@/lib/youcai-agent-routing";
import styles from "./official-model-tools.module.css";

interface MusicPlanResult {
  title?: string;
  lyrics?: string;
  stylePrompt?: string;
  arrangement?: string;
  vocalDirection?: string;
  text?: string;
}

export function MusicPreparationWorkbench() {
  const { state } = useApp();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [style, setStyle] = useState("流行音乐，明亮，适合短视频叙事");
  const [instrumental, setInstrumental] = useState(false);
  const [result, setResult] = useState<MusicPlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const prefill = consumeYoucaiMusicPrefill();
    if (prefill) setBrief(prefill);
  }, []);

  async function createPlan() {
    if (!brief.trim() || loading) return;
    if (!state.auth.token) {
      setError("请先登录，再生成歌词与编曲方案。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/tools/creative-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.auth.token}`,
        },
        body: JSON.stringify({
          operation: "music-plan",
          input: { title: title.trim(), brief: brief.trim(), lyrics: lyrics.trim(), style: style.trim(), instrumental },
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; result?: MusicPlanResult };
      if (!response.ok || !payload.result) throw new Error(payload.error || `方案生成失败（${response.status}）`);
      setResult(payload.result);
      if (payload.result.title) setTitle(payload.result.title);
      if (typeof payload.result.lyrics === "string") setLyrics(payload.result.lyrics);
      if (payload.result.stylePrompt) setStyle(payload.result.stylePrompt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "方案生成失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles.page} data-testid="music-preparation-workbench">
      <Link className={styles.backLink} href="/tools/audio">← 返回音频创作</Link>
      <header className={`${styles.hero} ${styles.musicHero}`}>
        <h1><Music2 size={32} aria-hidden="true" /> 音乐创作</h1>
        <p>输入歌曲主题，AI 会完成歌词、风格与编曲方案。</p>
      </header>

      <section className={styles.workspaceGrid}>
        <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); void createPlan(); }}>
          <h2><span className={`${styles.panelIcon} ${styles.musicIcon}`}><Music2 size={17} /></span> 生成设置</h2>
          <label className={styles.fieldLabel} htmlFor="music-title">歌曲标题</label>
          <input id="music-title" maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="可选；模型也可以根据主题命名" type="text" value={title} />

          <label className={styles.fieldLabel} htmlFor="music-brief">歌曲主题 <em>*</em></label>
          <textarea id="music-brief" maxLength={4_000} onChange={(event) => setBrief(event.target.value)} placeholder="例如：关于夏日海边的轻快治愈歌曲，用于宠物动画口播片尾" rows={4} value={brief} />

          <label className={styles.fieldLabel} htmlFor="music-lyrics">已有歌词（可选）</label>
          <textarea id="music-lyrics" maxLength={12_000} onChange={(event) => setLyrics(event.target.value)} placeholder="可加入 [Intro]、[Verse]、[Chorus]、[Bridge]、[Outro] 等结构标签" rows={8} value={lyrics} />

          <label className={styles.fieldLabel} htmlFor="music-style">音乐风格</label>
          <textarea id="music-style" maxLength={500} onChange={(event) => setStyle(event.target.value)} rows={3} value={style} />

          <label className={styles.checkboxRow}>
            <input checked={instrumental} onChange={(event) => setInstrumental(event.target.checked)} type="checkbox" />
            纯音乐模式（不生成歌词）
          </label>

          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <button className={styles.primaryButton} disabled={!brief.trim() || loading} type="submit">
            {loading ? <LoaderCircle className={styles.spinner} size={18} /> : <Sparkles size={18} />}
            {loading ? "正在生成方案" : "AI 生成歌词与编曲方案"}
          </button>
          <button className={styles.disabledGenerationButton} disabled type="button">
            音乐生成 · 即将上线
          </button>
        </form>

        <section className={styles.panel}>
          <h2><span className={`${styles.panelIcon} ${styles.musicIcon}`}><Music2 size={17} /></span> 方案结果</h2>
          {result ? (
            <div className={styles.resultBox}>
              <h3>{result.title || title || "未命名音乐方案"}</h3>
              {result.lyrics ? <><h4>歌词</h4><pre>{result.lyrics}</pre></> : null}
              {result.stylePrompt ? <><h4>风格提示</h4><p>{result.stylePrompt}</p></> : null}
              {result.arrangement ? <><h4>编曲</h4><p>{result.arrangement}</p></> : null}
              {result.vocalDirection ? <><h4>演唱指导</h4><p>{result.vocalDirection}</p></> : null}
              {result.text ? <pre>{result.text}</pre> : null}
            </div>
          ) : (
            <div className={styles.emptyResult}>
              <span className={styles.musicIcon}><Music2 size={26} /></span>
              <strong>输入歌曲主题并生成制作方案</strong>
              <small>生成后可继续修改歌词、风格、编曲与演唱方向。</small>
            </div>
          )}
        </section>
      </section>

      <section className={styles.truthPanel}>
        <CheckCircle2 size={22} />
        <div>
          <strong>创作流程</strong>
          <p>先生成歌词与编曲方案，音乐生成功能即将上线。</p>
        </div>
      </section>
    </main>
  );
}
