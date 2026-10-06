import Link from 'next/link';

const FEATURES = [
  {
    title: '语音合成',
    subtitle: 'TTS Workspace',
    desc: '调用火山引擎豆包语音模型，支持多语种、语音指令、情绪控制与高质量 TTS 输出。',
    href: '/workspace',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5 5 0 010 7.424M12 6l-4 4H4v4h4l4 4V6z" />
      </svg>
    ),
    accent: 'from-sky-400/20 to-cyan-300/5',
    glow: 'rgba(56,189,248,0.25)',
  },
  {
    title: '音色模仿',
    subtitle: 'Voice Imitation',
    desc: '模仿任意音色特征，快速生成相似声线，适用于配音、角色扮演和创意内容创作。',
    href: '/imitate',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
      </svg>
    ),
    accent: 'from-violet-400/20 to-purple-300/5',
    glow: 'rgba(167,139,250,0.25)',
  },
  {
    title: '声音复刻',
    subtitle: 'Voice Cloning',
    desc: '上传样本音频，训练专属声线，保留发音细节、气息和音色特征，完成克隆闭环。',
    href: '/clone',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    accent: 'from-emerald-400/20 to-teal-300/5',
    glow: 'rgba(52,211,153,0.25)',
  },
  {
    title: '声音设计',
    subtitle: 'Voice Design',
    desc: '用文字描述想要的声音特征，快速生成新的角色音色和商业口播音色。',
    href: '/design',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    ),
    accent: 'from-amber-400/20 to-orange-300/5',
    glow: 'rgba(251,191,36,0.25)',
  },
  {
    title: '音色库',
    subtitle: 'Voice Library',
    desc: '浏览 300+ 精选音色，涵盖官方、真人、经典人物和自定义分类，试听即选。',
    href: '/voices',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
    accent: 'from-rose-400/20 to-pink-300/5',
    glow: 'rgba(251,113,133,0.25)',
  },
];

const STATS = [
  { value: '300+', label: '精选音色' },
  { value: '18', label: '强指令音色' },
  { value: '44', label: '接近真人' },
  { value: '5', label: '核心功能' },
];

const STEPS = [
  { step: '01', title: '选音色', desc: '从官方、真人、经典人物和自定义音色中快速筛选，试听即选。' },
  { step: '02', title: '调参数', desc: '控制语速、音量、情绪、语音指令和输出格式，精细调校。' },
  { step: '03', title: '生成音频', desc: '在线试听、复制音色 ID，并进入工作台完成创作闭环。' },
];

function Spectrum({ bars = 48 }: { bars?: number }) {
  return (
    <div className="flex h-20 items-end gap-1 opacity-80" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="w-1.5 rounded-full bg-sky-300/70 audio-pulse"
          style={{
            height: `${14 + ((i * 11) % 70)}%`,
            animationDelay: `${i * 0.04}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="min-h-[100dvh] bg-vp-background text-vp-foreground">
      {/* ===== HERO ===== */}
      <section className="relative min-h-[88dvh] overflow-hidden tech-blue-grid">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(0,132,255,0.28),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(56,189,248,0.20),transparent_28%),linear-gradient(135deg,#050B18_0%,#07162F_45%,#03101F_100%)]" />
        <div className="absolute left-1/2 top-0 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-sky-400/10 blur-3xl" />
        <div className="absolute -right-24 top-28 h-72 w-72 rounded-full border border-vp-border blue-orbit" />
        <div className="absolute right-10 top-44 h-36 w-36 rounded-full border border-blue-300/20 blue-orbit blue-orbit-delay" />
        <div className="absolute left-12 top-24 h-20 w-20 rounded-full border border-cyan-300/20 blue-orbit blue-orbit-slow" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#050B18] to-transparent" />

        <div className="relative mx-auto grid max-w-7xl grid-cols-1 gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-24">
          <div className="flex flex-col justify-center">
            <div className="mb-6 inline-flex w-fit items-center gap-3 rounded-full border border-vp-border bg-sky-400/8 px-4 py-2 text-xs uppercase tracking-[0.28em] text-vp-primary shadow-[0_0_28px_rgba(56,189,248,0.12)]">
              <span className="h-2 w-2 rounded-full bg-sky-300 shadow-[0_0_18px_rgba(125,211,252,0.9)]" />
              Volcano Voice Engine
            </div>

            <h1 className="max-w-4xl text-5xl font-semibold leading-[1.03] tracking-[-0.05em] text-slate-50 md:text-7xl">
              智音工坊
              <span className="block text-vp-primary">AI 配音控制台</span>
            </h1>

            <p className="mt-6 max-w-2xl text-base leading-8 text-vp-foreground md:text-lg">
              面向短视频、口播、角色配音和声音复刻的一站式语音生成平台。五大核心功能，300+ 精选音色，科技蓝视觉承载全流程创作。
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="/workspace" className="inline-flex items-center justify-center rounded-2xl bg-sky-300 px-7 py-3.5 text-sm font-semibold text-slate-950 shadow-[0_0_34px_rgba(56,189,248,0.35)] transition hover:bg-sky-200 active:scale-[0.98]">
                进入工作台
                <svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
              <Link href="/voices" className="inline-flex items-center justify-center rounded-2xl border border-sky-300/25 bg-slate-900/60 px-7 py-3.5 text-sm font-semibold text-sky-100 backdrop-blur-xl transition hover:border-vp-border0 hover:bg-sky-300/10 active:scale-[0.98]">
                浏览音色库
              </Link>
            </div>

            <div className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-4">
              {STATS.map((stat) => (
                <div key={stat.label} className="rounded-2xl border border-vp-border bg-vp-card/75 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-xl">
                  <div className="text-2xl font-semibold text-vp-primary">{stat.value}</div>
                  <div className="mt-1 text-xs text-vp-muted-foreground">{stat.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 右侧声纹监控卡 */}
          <div className="relative flex items-center justify-center lg:justify-end">
            <div className="relative w-full max-w-[520px] rounded-[2rem] border border-sky-300/18 bg-vp-card/72 p-5 shadow-[0_30px_100px_rgba(0,0,0,0.45),0_0_80px_rgba(14,165,233,0.12)] backdrop-blur-2xl">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-vp-primary/70">Live Audio Monitor</div>
                  <div className="mt-1 text-lg font-semibold text-slate-50">实时声纹引擎</div>
                </div>
                <div className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs text-emerald-200">ONLINE</div>
              </div>

              <div className="rounded-3xl border border-vp-border bg-vp-card/70 p-5">
                <Spectrum />
                <div className="mt-6 grid grid-cols-3 gap-3 text-center text-xs">
                  <div className="rounded-2xl bg-sky-300/8 px-3 py-3 text-vp-muted-foreground">
                    Model
                    <div className="mt-1 text-vp-primary">2.0</div>
                  </div>
                  <div className="rounded-2xl bg-sky-300/8 px-3 py-3 text-vp-muted-foreground">
                    Voice
                    <div className="mt-1 text-vp-primary">COT</div>
                  </div>
                  <div className="rounded-2xl bg-sky-300/8 px-3 py-3 text-vp-muted-foreground">
                    Output
                    <div className="mt-1 text-vp-primary">MP3</div>
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-3">
                {['语音指令解析', '情绪曲线匹配', '音频分片合成', '声纹稳定检测'].map((item, index) => (
                  <div key={item} className="flex items-center gap-3 rounded-2xl border border-vp-border bg-slate-950/35 px-4 py-3">
                    <span className="h-2.5 w-2.5 rounded-full bg-sky-300 shadow-[0_0_14px_rgba(125,211,252,0.8)]" />
                    <span className="text-sm text-vp-foreground">{item}</span>
                    <span className="ml-auto text-xs text-vp-muted-foreground">0{index + 1}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== 五大功能网格 ===== */}
      <section className="relative border-t border-vp-border bg-vp-card/90 py-20">
        <div className="absolute inset-0 tech-blue-grid opacity-60" />
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-12 flex items-end justify-between gap-6">
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-vp-primary/70">Core Modules</div>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">五大核心功能</h2>
            </div>
            <p className="hidden max-w-xl text-sm leading-7 text-vp-muted-foreground sm:block">
              统一音色、工作台、模仿、复刻和设计的视觉语言，一站式覆盖声音创作全流程。
            </p>
          </div>

          {/* Bento Grid: 2大3小 */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {/* 前两个大卡 — 跨2列 */}
            {FEATURES.slice(0, 2).map((feature) => (
              <Link
                key={feature.title}
                href={feature.href}
                className="group relative overflow-hidden rounded-[1.75rem] border border-vp-border bg-vp-card/75 p-8 shadow-[0_24px_70px_rgba(0,0,0,0.28)] transition duration-300 hover:-translate-y-1 hover:border-sky-300/30 hover:bg-vp-background/85 lg:col-span-3 lg:row-span-1"
                style={{ minHeight: '220px' }}
              >
                <div className={`absolute inset-0 bg-gradient-to-br ${feature.accent}`} />
                <div className="relative flex items-start gap-6">
                  <div
                    className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-vp-border bg-slate-950/40 text-vp-primary transition group-hover:scale-110"
                    style={{ boxShadow: `0 0 30px ${feature.glow}` }}
                  >
                    {feature.icon}
                  </div>
                  <div className="flex-1">
                    <div className="text-xs uppercase tracking-[0.24em] text-vp-primary/60">{feature.subtitle}</div>
                    <h3 className="mt-1 text-2xl font-semibold text-slate-50">{feature.title}</h3>
                    <p className="mt-2 max-w-lg text-sm leading-7 text-vp-muted-foreground">{feature.desc}</p>
                    <div className="mt-4 inline-flex items-center text-sm font-medium text-vp-primary">
                      立即使用
                      <svg className="ml-1.5 h-4 w-4 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                </div>
              </Link>
            ))}

            {/* 后三个小卡 */}
            {FEATURES.slice(2).map((feature) => (
              <Link
                key={feature.title}
                href={feature.href}
                className="group relative overflow-hidden rounded-[1.5rem] border border-vp-border bg-vp-card/75 p-7 shadow-[0_20px_60px_rgba(0,0,0,0.25)] transition duration-300 hover:-translate-y-1 hover:border-sky-300/25 hover:bg-vp-background/85"
              >
                <div className={`absolute inset-0 bg-gradient-to-br ${feature.accent}`} />
                <div
                  className="relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-vp-border bg-slate-950/40 text-vp-primary transition group-hover:scale-110"
                  style={{ boxShadow: `0 0 24px ${feature.glow}` }}
                >
                  {feature.icon}
                </div>
                <div className="relative text-xs uppercase tracking-[0.24em] text-vp-primary/60">{feature.subtitle}</div>
                <h3 className="relative mt-1 text-xl font-semibold text-slate-50">{feature.title}</h3>
                <p className="relative mt-3 text-sm leading-7 text-vp-muted-foreground">{feature.desc}</p>
                <div className="relative mt-4 inline-flex items-center text-sm font-medium text-vp-primary">
                  立即使用
                  <svg className="ml-1.5 h-4 w-4 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ===== 三步流程 ===== */}
      <section className="border-t border-vp-border py-18 bg-vp-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20">
          <div className="mb-12 text-center">
            <div className="text-xs uppercase tracking-[0.3em] text-vp-primary/70">How It Works</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">三步完成创作</h2>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {STEPS.map((item) => (
              <div key={item.step} className="rounded-[1.75rem] border border-vp-border bg-vp-card/68 p-7">
                <div className="text-xs uppercase tracking-[0.28em] text-vp-primary/70">Step {item.step}</div>
                <h3 className="mt-4 text-xl font-semibold text-slate-50">{item.title}</h3>
                <p className="mt-3 text-sm leading-7 text-vp-muted-foreground">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== CTA ===== */}
      <section className="relative overflow-hidden border-t border-vp-border bg-[linear-gradient(135deg,#07162F_0%,#050B18_100%)] py-20">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(56,189,248,0.14),transparent_35%)]" />
        <div className="relative mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">开始你的科技蓝配音工作流</h2>
          <p className="mt-4 text-base leading-8 text-vp-foreground">进入工作台、浏览音色库、模仿声音、复刻声线、设计音色，全流程统一深蓝科技视觉。</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/workspace" className="inline-flex items-center justify-center rounded-2xl bg-sky-300 px-7 py-3.5 text-sm font-semibold text-slate-950 shadow-[0_0_34px_rgba(56,189,248,0.32)] transition hover:bg-sky-200 active:scale-[0.98]">
              免费开始使用
            </Link>
            <Link href="/voices" className="inline-flex items-center justify-center rounded-2xl border border-sky-300/25 bg-slate-900/60 px-7 py-3.5 text-sm font-semibold text-sky-100 backdrop-blur-xl transition hover:border-vp-border0 hover:bg-sky-300/10 active:scale-[0.98]">
              查看音色库
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
