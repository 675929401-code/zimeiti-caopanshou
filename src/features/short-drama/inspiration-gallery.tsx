"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Compass, ImageIcon, Layers3, Search, Sparkles } from "lucide-react";
import { INSPIRATION_CATEGORIES, INSPIRATION_EXAMPLES } from "./inspiration-catalog";
import type { InspirationCategory } from "./types";
import styles from "@/app/short-drama/short-drama.module.css";

export function InspirationGallery() {
  const [category, setCategory] = useState<InspirationCategory>("全部");
  const [query, setQuery] = useState("");

  const visibleExamples = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return INSPIRATION_EXAMPLES.filter((example) => {
      if (category !== "全部" && example.category !== category) return false;
      if (!keyword) return true;
      return [example.title, example.category, example.summary, example.method, example.style]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword));
    });
  }, [category, query]);

  return (
    <main className={styles.root}>
      <div className={styles.ambientOne} aria-hidden="true" />
      <div className={styles.ambientTwo} aria-hidden="true" />
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link className={styles.brand} href="/short-drama">
            <span className={styles.brandMark}><Compass size={20} /></span>
            <span><b>影视工坊</b><small>灵感广场</small></span>
          </Link>
          <nav className={styles.topnav} aria-label="灵感广场导航">
            <Link href="/short-drama">项目门户</Link>
            <Link href="/storyboard-workbench?entry=inspiration">分镜工作台</Link>
          </nav>
          <Link className={styles.topbarAction} href="/short-drama">
            <ArrowLeft size={15} />
            返回工坊
          </Link>
        </header>

        <section className={styles.inspirationHero} aria-labelledby="inspiration-title">
          <div>
            <p className={styles.heroKicker}><Sparkles size={16} />原创方法示例</p>
            <h1 id="inspiration-title">先看创作结构，<br /><span>再带着方法开工。</span></h1>
            <p>
              这里展示的是我方原创示例配置与本地主站图片，帮助理解叙事、风格和镜头组织方式；不是对标官网素材库，也不包含抓取内容。
            </p>
          </div>
          <aside className={styles.inspirationPrinciples} aria-label="灵感广场使用原则">
            <span><ImageIcon size={19} /><b>素材来源</b><small>主站 public/short-drama</small></span>
            <span><Layers3 size={19} /><b>使用方式</b><small>方法参考，不自动生成</small></span>
            <span><Compass size={19} /><b>下一步</b><small>带入分镜继续制作</small></span>
          </aside>
        </section>

        <section className={styles.inspirationToolbar} aria-label="筛选灵感示例">
          <div className={styles.categoryTabs} role="group" aria-label="灵感分类">
            {INSPIRATION_CATEGORIES.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={category === item}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <label className={styles.searchBox}>
            <Search size={16} aria-hidden="true" />
            <span className={styles.srOnly}>搜索灵感示例</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索题材、方法或风格"
            />
          </label>
        </section>

        <section className={styles.inspirationSection} aria-live="polite">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>INSPIRATION</p>
              <h2>{category === "全部" ? "全部示例" : category}</h2>
            </div>
            <p>共 {visibleExamples.length} 个原创示例</p>
          </div>

          {visibleExamples.length === 0 ? (
            <div className={styles.statePanel} data-tone="empty">
              <Search size={28} aria-hidden="true" />
              <div>
                <h3>没有匹配的灵感示例</h3>
                <p>换一个分类或清空关键词即可继续浏览。</p>
              </div>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => { setCategory("全部"); setQuery(""); }}
              >
                清空筛选
              </button>
            </div>
          ) : (
            <div className={styles.inspirationGrid}>
              {visibleExamples.map((example) => (
                <article className={styles.inspirationCard} key={example.id}>
                  <div className={styles.inspirationImage}>
                    <Image
                      src={example.imagePath}
                      alt={example.imageAlt}
                      fill
                      sizes="(max-width: 760px) 100vw, (max-width: 1200px) 50vw, 560px"
                    />
                    <span className={styles.imageBadge}>{example.category}</span>
                    <span className={styles.ratioBadge}>{example.ratio}</span>
                  </div>
                  <div className={styles.inspirationBody}>
                    <p className={styles.entryEyebrow}>{example.style}</p>
                    <h3>{example.title}</h3>
                    <p>{example.summary}</p>
                    <div className={styles.methodBox}>
                      <strong>方法拆解</strong>
                      <span>{example.method}</span>
                    </div>
                    <div className={styles.inspirationActions}>
                      <Link className={styles.primaryButton} href={example.primaryHref}>
                        带入分镜
                        <ArrowRight size={15} />
                      </Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <footer className={styles.footer}>
          <p><Sparkles size={16} />示例图片与文案均为本项目原创配置，不从外部网站实时加载。</p>
          <Link href="/short-drama">返回影视工坊</Link>
        </footer>
      </div>
    </main>
  );
}
