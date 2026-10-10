"use client";

import {
  ArrowLeft,
  BellRing,
  BookmarkCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Gift,
  Layers3,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./popup-style-lab.module.css";

type StyleId = "ivory" | "mist" | "sand" | "editorial" | "coral";
type ViewMode = "compare" | "compact" | "reader";

type StyleOption = {
  id: StyleId;
  number: string;
  name: string;
  signature: string;
  description: string;
  traits: readonly string[];
  className: string;
};

const STORAGE_KEY = "zimeiti.popup-style-lab.selection.v1";

const STYLE_OPTIONS: readonly StyleOption[] = [
  {
    id: "ivory",
    number: "01",
    name: "象牙纸墨",
    signature: "温润纸感 · 清晰长读",
    description: "像一封被认真排版的会员来信，克制、耐看，适合制度说明与长公告。",
    traits: ["纸张层次", "墨色正文", "酒红强调"],
    className: styles.toneIvory,
  },
  {
    id: "mist",
    number: "02",
    name: "雾青玻璃",
    signature: "浅雾玻璃 · 深海承托",
    description: "用通透浅表面承载正文，在深色产品背景里依然保持清晰边界与呼吸感。",
    traits: ["雾青高光", "玻璃边界", "青绿按钮"],
    className: styles.toneMist,
  },
  {
    id: "sand",
    number: "03",
    name: "暖砂金线",
    signature: "暖砂底色 · 细金秩序",
    description: "轻奢但不浮夸，适合会员升级、礼包到账和高价值权益通知。",
    traits: ["暖砂表面", "金线分区", "深棕主按钮"],
    className: styles.toneSand,
  },
  {
    id: "editorial",
    number: "04",
    name: "蓝灰编辑部",
    signature: "编辑排版 · 信息优先",
    description: "以杂志编辑部的版式组织复杂信息，标题醒目、层级明确、扫读效率高。",
    traits: ["蓝灰网格", "栏目编号", "直角信息块"],
    className: styles.toneEditorial,
  },
  {
    id: "coral",
    number: "05",
    name: "珊瑚提示",
    signature: "友好提醒 · 轻快行动",
    description: "明快但不刺眼，适合活动提醒、新功能上线和需要用户立即行动的消息。",
    traits: ["珊瑚强调", "柔和圆角", "行动导向"],
    className: styles.toneCoral,
  },
] as const;

const READER_MESSAGES = [
  {
    id: "growth-gift",
    meta: "会员权益通知 · 2026/10/09",
    title: "一份给认真创作者的成长礼包",
    lead: "你好，欢迎回来。你离线期间收到了一份创作者成长礼包，我们把到账内容、使用范围和有效期集中整理在这里，避免遗漏任何一项权益。",
    summary: ["2,000 积分已自动到账", "有效期至 11 月 30 日"],
    sections: [
      {
        title: "本次到账内容",
        body: "你的创作者成长礼包已生效：包含 2,000 积分、三项进阶工作台权限，以及本月专属素材模板。所有权益已直接进入当前账号，无需再次领取。",
      },
      {
        title: "使用范围",
        body: "新增权益可用于文案策划、分镜预演和封面方案生成。每次执行前仍会显示预计消耗，只有你主动确认后才会开始任务。",
      },
      {
        title: "有效期与保留规则",
        body: "礼包有效期至 2026 年 11 月 30 日。有效期内已创建的项目、历史记录和导出文件不会因礼包到期而消失；未使用积分按活动规则处理。",
      },
      {
        title: "需要帮助时",
        body: "如果到账内容与页面显示不一致，请先刷新个人中心，再通过帮助中心提交问题。请勿重复支付或重复兑换，我们会依据原始记录核对。",
      },
    ],
  },
  {
    id: "task-reward",
    meta: "任务奖励通知 · 2026/10/08",
    title: "连续创作任务奖励已补发",
    lead: "我们已完成上周连续创作任务的核对，你符合补发条件。奖励已经进入当前账号，本条消息用于说明补发原因和使用边界。",
    summary: ["600 积分已补发", "无需再次提交任务"],
    sections: [
      {
        title: "补发原因",
        body: "系统复核发现，你在统计截止前已完成全部创作步骤，但最后一项状态同步稍有延迟。此次补发不会扣减原有积分，也不会重复计算任务进度。",
      },
      {
        title: "到账位置",
        body: "600 积分已经计入账户余额，可在个人中心的积分明细中查看“连续创作任务补发”记录。当前消息仅作说明，不需要再次点击领取。",
      },
      {
        title: "使用说明",
        body: "补发积分与常规积分的使用范围一致，可用于平台内已开放的创作工具。每次产生消耗前仍会展示预计用量，由你确认后执行。",
      },
      {
        title: "异常反馈",
        body: "如果积分明细仍未显示，请保留本条通知并通过帮助中心反馈。我们会按同一任务记录复核，请勿重复兑换或发起付费操作。",
      },
    ],
  },
  {
    id: "monthly-bonus",
    meta: "会员加赠通知 · 2026/10/01",
    title: "本月会员加赠权益说明",
    lead: "本月会员加赠已生效，包含两套限定模板与一次进阶工作台体验。这里列出开放时间、使用方式和到期后的保留规则。",
    summary: ["2 套限定模板", "1 次进阶体验"],
    sections: [
      {
        title: "加赠内容",
        body: "本次加赠包含“口播提效”和“图文拆解”两套限定模板，以及一次进阶工作台体验资格。加赠项目已经绑定当前会员账号。",
      },
      {
        title: "开放时间",
        body: "限定模板自到账后即可使用；进阶体验资格将在首次主动确认时启用。未确认前不会开始计时，也不会产生任何积分消耗。",
      },
      {
        title: "项目保留",
        body: "权益到期前创建的项目仍会保留在生成记录中，后续可以查看与导出。到期只影响再次使用限定能力，不会删除已有内容。",
      },
      {
        title: "查看详情",
        body: "你可以在会员中心查看每项权益的状态和剩余期限。若页面状态与本通知不一致，请以账户明细为线索提交核对。",
      },
    ],
  },
] as const;

function isStyleId(value: string | null): value is StyleId {
  return STYLE_OPTIONS.some((option) => option.id === value);
}

function CompactPreview({ option }: { option: StyleOption }) {
  return (
    <section className={styles.previewColumn} aria-labelledby={`${option.id}-compact-title`}>
      <div className={styles.previewLabel}>
        <span>A</span>
        <div>
          <strong>小卡 · 在线轻提醒</strong>
          <small>用户正在使用时出现 · 不打断当前操作</small>
        </div>
      </div>

      <div className={styles.compactStage} data-popup-preview="compact" data-style={option.id}>
        <article className={styles.compactCard} aria-label={`${option.name}紧凑公告预览`}>
          <header className={styles.compactHeader}>
            <span className={styles.iconTile} aria-hidden="true"><Gift size={18} /></span>
            <div className={styles.compactHeading}>
              <span>权益到账</span>
              <small>刚刚</small>
            </div>
            <span className={styles.unreadDot} aria-label="未读消息" />
          </header>
          <div className={styles.compactBody}>
            <h3 id={`${option.id}-compact-title`}>创作者成长礼包已到账</h3>
            <p>2,000 积分与 3 项进阶权限已进入你的账号，可立即使用。</p>
            <div className={styles.benefitRow}>
              <span><Sparkles size={14} />2,000 积分</span>
              <span><ShieldCheck size={14} />30 天有效</span>
            </div>
          </div>
          <footer className={styles.compactFooter}>
            <button type="button" className={styles.textButton}>稍后查看</button>
            <button type="button" className={styles.primaryButton}>查看权益 <ChevronRight size={15} /></button>
          </footer>
        </article>
      </div>
    </section>
  );
}

function ReaderPreview({ option }: { option: StyleOption }) {
  const [messageIndex, setMessageIndex] = useState(0);
  const [readMessages, setReadMessages] = useState<ReadonlySet<number>>(() => new Set());
  const message = READER_MESSAGES[messageIndex];
  const unreadCount = READER_MESSAGES.length - readMessages.size;

  const acknowledgeMessage = () => {
    setReadMessages((current) => {
      const next = new Set(current);
      next.add(messageIndex);
      return next;
    });
  };

  return (
    <section className={styles.previewColumn} aria-labelledby={`${option.id}-reader-title`}>
      <div className={styles.previewLabel}>
        <span>B</span>
        <div>
          <strong>大窗 · 登录积压 / 详情</strong>
          <small>未登录期间派发 → 下次登录集中查看 · 支持翻页</small>
        </div>
      </div>

      <div className={styles.readerStage} data-popup-preview="reader" data-style={option.id}>
        <article className={styles.readerWindow} aria-label={`${option.name}大公告预览`}>
          <header className={styles.readerHeader}>
            <span className={styles.readerIcon} aria-hidden="true"><BellRing size={21} /></span>
            <div className={styles.readerHeading}>
              <span>{message.meta}</span>
              <h3 id={`${option.id}-reader-title`} data-reader-message-title aria-live="polite">{message.title}</h3>
            </div>
            <button type="button" className={styles.closeButton} aria-label="关闭预览弹窗"><X size={19} /></button>
          </header>

          <div className={styles.popupBody} data-popup-scroll-region tabIndex={0} key={message.id}>
            <p className={styles.lead}>{message.lead}</p>
            <div className={styles.summaryStrip}>
              <span><BookmarkCheck size={17} /> {message.summary[0]}</span>
              <span><Clock3 size={17} /> {message.summary[1]}</span>
            </div>
            {message.sections.map((section, index) => (
              <section className={styles.noticeSection} key={section.title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h4>{section.title}</h4>
                  <p>{section.body}</p>
                </div>
              </section>
            ))}
          </div>

          <footer className={styles.readerFooter}>
            <div className={styles.readerStatus} aria-live="polite">
              <strong data-reader-page-indicator>{String(messageIndex + 1).padStart(2, "0")} / {String(READER_MESSAGES.length).padStart(2, "0")}</strong>
              <span data-reader-unread-count>{unreadCount} 条未读</span>
            </div>
            <div className={styles.readerActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                data-reader-action="previous"
                aria-label="上一条消息"
                disabled={messageIndex === 0}
                onClick={() => setMessageIndex((current) => Math.max(0, current - 1))}
              >
                <ChevronLeft size={14} /> 上一条
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                data-reader-action="next"
                aria-label="下一条消息"
                disabled={messageIndex === READER_MESSAGES.length - 1}
                onClick={() => setMessageIndex((current) => Math.min(READER_MESSAGES.length - 1, current + 1))}
              >
                下一条 <ChevronRight size={14} />
              </button>
              <button type="button" className={styles.primaryButton} data-reader-action="acknowledge" onClick={acknowledgeMessage}>
                <Check size={14} /> 知道了
              </button>
            </div>
          </footer>
        </article>
      </div>
    </section>
  );
}

export function PopupStyleLab() {
  const [selectedStyle, setSelectedStyle] = useState<StyleId>("ivory");
  const [viewMode, setViewMode] = useState<ViewMode>("compare");
  const [selectionReady, setSelectionReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (isStyleId(saved)) setSelectedStyle(saved);
    } catch {
      // Local preview remains usable when browser storage is unavailable.
    } finally {
      setSelectionReady(true);
    }
  }, []);

  const chooseStyle = (id: StyleId) => {
    setSelectedStyle(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Selection still works for the current tab without persistent storage.
    }
  };

  const selectedOption = STYLE_OPTIONS.find((option) => option.id === selectedStyle) ?? STYLE_OPTIONS[0];

  return (
    <main className={styles.lab} data-testid="popup-style-lab">
      <div className={styles.ambientOne} data-ambient-decoration aria-hidden="true" />
      <div className={styles.ambientTwo} data-ambient-decoration aria-hidden="true" />

      <header className={styles.hero}>
        <Link className={styles.backLink} href="/"><ArrowLeft size={16} /> 返回主站</Link>
        <div className={styles.heroMeta}>
          <span><Layers3 size={15} /> Popup Style Lab</span>
          <span>1440 × 900 桌面预览</span>
          <span>零 API · 零计费</span>
        </div>
        <div className={styles.heroCopy}>
          <div>
            <p className={styles.eyebrow}>公告 / 权益通知 · 统一视觉方案</p>
            <h1>让内容先被看清，<br /><span>再谈氛围。</span></h1>
          </div>
          <p className={styles.heroDescription}>五套原创方向同时展示两种职责：用户在线时用小卡轻提醒；奖励在未登录期间派发时，下次登录用大窗承接积压消息与详情。大窗可逐条翻阅，正文统一使用高对比实色与 17px 字号。</p>
        </div>

        <div className={styles.controlBar}>
          <div className={styles.viewSwitch} role="group" aria-label="预览尺寸">
            {([
              ["compare", "两尺寸并排"],
              ["compact", "只看紧凑卡"],
              ["reader", "只看阅读窗"],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={viewMode === id} onClick={() => setViewMode(id)}>{label}</button>
            ))}
          </div>
          <div className={styles.selectionStatus} role="status" aria-live="polite">
            <span>当前选择</span>
            <strong>{selectedOption.number} · {selectedOption.name}</strong>
            <small>{selectionReady ? "已同步到本浏览器" : "正在读取本地选择"}</small>
          </div>
        </div>
        <p className={styles.localNotice}><ShieldCheck size={15} /> 选择只写入 localStorage，不调用接口、不写数据库，也不会改变正式系统。</p>
      </header>

      <section className={styles.gallery} aria-label="五套弹窗风格方案" data-view={viewMode}>
        {STYLE_OPTIONS.map((option) => {
          const selected = selectedStyle === option.id;
          return (
            <article className={`${styles.styleShowcase} ${option.className} ${selected ? styles.isSelected : ""}`} data-style-option={option.id} data-selected={selected} key={option.id}>
              <header className={styles.optionHeader}>
                <div className={styles.optionNumber}>{option.number}</div>
                <div className={styles.optionTitle}>
                  <p>{option.signature}</p>
                  <h2>{option.name}</h2>
                  <span>{option.description}</span>
                </div>
                <div className={styles.optionActions}>
                  <ul aria-label="风格特征">
                    {option.traits.map((trait) => <li key={trait}>{trait}</li>)}
                  </ul>
                  <button type="button" className={styles.selectButton} aria-pressed={selected} onClick={() => chooseStyle(option.id)}>
                    {selected ? <><Check size={16} /> 已选此方案</> : <>选择此方案 <ChevronRight size={16} /></>}
                  </button>
                </div>
              </header>

              <div className={styles.previewGrid}>
                <CompactPreview option={option} />
                <ReaderPreview option={option} />
              </div>
            </article>
          );
        })}
      </section>

      <footer className={styles.pageFooter}>
        <div>
          <BellRing size={18} />
          <span>本页仅用于选择视觉方向</span>
        </div>
        <p>确认方案后再单独迁移到正式公告组件；本 Demo 不代表已经上线。</p>
      </footer>
    </main>
  );
}
