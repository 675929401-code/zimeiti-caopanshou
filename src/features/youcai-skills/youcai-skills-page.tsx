"use client";

import {
  AlertCircle,
  BadgeCheck,
  Bot,
  Check,
  Download,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/contexts/app-context";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import {
  YOUCAI_SKILL_CATALOG,
  YOUCAI_SKILL_CATEGORIES,
  YOUCAI_SKILL_TAGS,
  type YoucaiSkillCategory,
  type YoucaiSkillSource,
} from "@/lib/youcai-skill-catalog";
import {
  describeSkillApiError,
  installPublishedSkill,
  listPublishedSkills,
  uninstallPublishedSkill,
  type PublicSkillPackage,
  type PublicSkillSource,
} from "./youcai-skill-api";
import styles from "./youcai-skills-page.module.css";

type StoreTab = "store" | "mine";
type SourceFilter = "all" | YoucaiSkillSource;
type CategoryFilter = "all" | YoucaiSkillCategory;
type CatalogMode = "loading" | "published" | "builtin";
type NoticeTone = "info" | "success" | "warning" | "error";

interface Notice {
  tone: NoticeTone;
  message: string;
  code?: string;
}

interface SkillViewModel {
  key: string;
  staticId?: string;
  sourceGroup: YoucaiSkillSource;
  sourceKind?: PublicSkillSource;
  sourceLabel: string;
  title: string;
  commandName: string;
  category: YoucaiSkillCategory;
  categoryLabel: string;
  tags: readonly string[];
  version: string;
  author: string;
  priceCredits: number;
  summary: string;
  contract: string;
  installed: boolean;
  enabled: boolean;
  agentReady: boolean;
  package?: PublicSkillPackage;
}

const CATEGORY_LABELS = new Map(YOUCAI_SKILL_CATEGORIES.map((item) => [item.value, item.label]));
const CATEGORY_VALUES = new Set<YoucaiSkillCategory>(YOUCAI_SKILL_CATEGORIES.map((item) => item.value));

function normalizeWorkspaceBrand(value: string): string {
  return value
    .replaceAll("有彩视界", "漫剧工作台")
    .replaceAll("有彩世界", "漫剧工作台");
}

function compactSummary(summary: string): string {
  const normalized = normalizeWorkspaceBrand(summary);
  return normalized.length > 92 ? `${normalized.slice(0, 92)}…` : normalized;
}

function normalizeCommandName(commandName: string): string {
  return commandName.trim().replace(/^\/+/, "").toLowerCase();
}

function isSkillCategory(value: string): value is YoucaiSkillCategory {
  return CATEGORY_VALUES.has(value as YoucaiSkillCategory);
}

function sourceLabel(source: PublicSkillSource): string {
  if (source === "open_source") return "开源公开";
  if (source === "community") return "社区发布";
  if (source === "custom") return "平台自定义";
  return "平台内置";
}

function sourceGroup(source: PublicSkillSource): YoucaiSkillSource {
  return source === "builtin" || source === "custom" ? "official" : "community";
}

function formatPublishedAt(value: string): string {
  if (!value) return "未提供";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function schemaSummary(schema: Record<string, unknown>): string {
  const schemaType = typeof schema.type === "string" ? schema.type : "object";
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? Object.keys(schema.properties as Record<string, unknown>)
    : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  if (properties.length === 0) return `类型：${schemaType}；未声明公开字段。`;
  const fieldText = properties.slice(0, 12).join("、");
  const suffix = properties.length > 12 ? ` 等 ${properties.length} 项` : "";
  return `类型：${schemaType}；字段：${fieldText}${suffix}；必填：${required.length > 0 ? required.join("、") : "无"}。`;
}

function permissionSummary(skillPackage: PublicSkillPackage): string {
  if (skillPackage.permissions.length === 0) return "无需额外权限。";
  return skillPackage.permissions
    .map((item) => `${item.required ? "必需" : "可选"} · ${item.capability}${item.description ? `（${item.description}）` : ""}`)
    .join("；");
}

function buildSkillViewModels(packages: PublicSkillPackage[]): SkillViewModel[] {
  const packageByCommand = new Map<string, PublicSkillPackage>();
  for (const skillPackage of packages) {
    const commandName = normalizeCommandName(skillPackage.commandName);
    if (commandName && !packageByCommand.has(commandName)) packageByCommand.set(commandName, skillPackage);
  }

  const builtins = YOUCAI_SKILL_CATALOG.map((skill): SkillViewModel => {
    const skillPackage = packageByCommand.get(normalizeCommandName(skill.commandName));
    if (skillPackage) packageByCommand.delete(normalizeCommandName(skill.commandName));
    return {
      key: skillPackage?.packageId || skill.id,
      staticId: skill.id,
      sourceGroup: skillPackage ? sourceGroup(skillPackage.source) : skill.source,
      sourceKind: skillPackage?.source,
      sourceLabel: skillPackage ? sourceLabel(skillPackage.source) : "内置 Skill 目录",
      title: normalizeWorkspaceBrand(skillPackage?.title || skill.title),
      commandName: normalizeCommandName(skillPackage?.commandName || skill.commandName),
      category: skillPackage && isSkillCategory(skillPackage.category) ? skillPackage.category : skill.category,
      categoryLabel: skillPackage && isSkillCategory(skillPackage.category)
        ? CATEGORY_LABELS.get(skillPackage.category) || skill.categoryLabel
        : skill.categoryLabel,
      tags: skillPackage?.tags.length ? skillPackage.tags : skill.tags,
      version: skillPackage?.version || skill.version,
      author: normalizeWorkspaceBrand(skillPackage?.author || skill.author),
      priceCredits: skillPackage?.priceCredits ?? skill.priceCredits,
      summary: normalizeWorkspaceBrand(skillPackage?.summary || skill.summary),
      contract: skill.contract,
      installed: Boolean(skillPackage?.installed),
      enabled: skillPackage?.enabled ?? true,
      agentReady: true,
      package: skillPackage,
    };
  });

  const publishedOnly = [...packageByCommand.values()].map((skillPackage): SkillViewModel => {
    const category = isSkillCategory(skillPackage.category) ? skillPackage.category : "productivity";
    return {
      key: skillPackage.packageId,
      sourceGroup: sourceGroup(skillPackage.source),
      sourceKind: skillPackage.source,
      sourceLabel: sourceLabel(skillPackage.source),
      title: normalizeWorkspaceBrand(skillPackage.title),
      commandName: normalizeCommandName(skillPackage.commandName),
      category,
      categoryLabel: CATEGORY_LABELS.get(category) || "效率工具",
      tags: skillPackage.tags,
      version: skillPackage.version,
      author: normalizeWorkspaceBrand(skillPackage.author),
      priceCredits: skillPackage.priceCredits,
      summary: normalizeWorkspaceBrand(skillPackage.summary),
      contract: "该发布包尚未进入当前 Agent 的 36 项内置运行目录；安装仅记录包生命周期，不代表运行时已经接线。",
      installed: skillPackage.installed,
      enabled: skillPackage.enabled,
      agentReady: false,
      package: skillPackage,
    };
  });

  return [...builtins, ...publishedOnly];
}

export function YoucaiSkillsPage() {
  const router = useAppScopedRouter();
  const { state } = useApp();
  const [tab, setTab] = useState<StoreTab>("store");
  const [source, setSource] = useState<SourceFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [tag, setTag] = useState("all");
  const [query, setQuery] = useState("");
  const [catalogMode, setCatalogMode] = useState<CatalogMode>("loading");
  const [publishedPackages, setPublishedPackages] = useState<PublicSkillPackage[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pendingPackageId, setPendingPackageId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>({
    tone: "info",
    message: "正在读取 Skill 包发布目录…",
  });

  const refreshCatalog = useCallback(async (signal?: AbortSignal, preserveNotice = false) => {
    if (!preserveNotice) {
      setCatalogMode("loading");
      setNotice({ tone: "info", message: "正在读取 Skill 包发布目录…" });
    }
    try {
      const packages = await listPublishedSkills(state.auth.token, signal);
      setPublishedPackages(packages);
      setCatalogMode("published");
      if (!preserveNotice) {
        setNotice({
          tone: "success",
          message: `已连接 Skill 包服务：读取 ${packages.length} 个已发布包；未发布能力继续由内置 36 项目录提供。`,
        });
      }
      return true;
    } catch (error) {
      const described = describeSkillApiError(error);
      if (described.code === "ABORTED") return false;
      if (described.fallbackToBuiltin) {
        setPublishedPackages([]);
        setCatalogMode("builtin");
      }
      setNotice({ tone: described.fallbackToBuiltin ? "warning" : "error", message: described.message, code: described.code });
      return false;
    }
  }, [state.auth.token]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshCatalog(controller.signal);
    return () => controller.abort();
  }, [refreshCatalog]);

  useEffect(() => {
    if (!selectedKey) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedKey]);

  const skills = useMemo(() => buildSkillViewModels(publishedPackages), [publishedPackages]);
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.key === selectedKey) || null,
    [selectedKey, skills],
  );
  const visibleSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (tab === "mine" && !skill.installed) return false;
      if (source !== "all" && skill.sourceGroup !== source) return false;
      if (category !== "all" && skill.category !== category) return false;
      if (tag !== "all" && !skill.tags.includes(tag)) return false;
      if (!normalizedQuery) return true;
      return [skill.title, skill.commandName, skill.summary, skill.categoryLabel, skill.sourceLabel, skill.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [category, query, skills, source, tab, tag]);

  const officialCount = skills.filter((skill) => skill.sourceGroup === "official").length;
  const communityCount = skills.length - officialCount;
  const mineCount = skills.filter((skill) => skill.installed).length;

  function openAgentWithCommand(skill: SkillViewModel) {
    if (!skill.agentReady) {
      setNotice({
        tone: "warning",
        message: `「${skill.title}」已出现在发布目录，但尚未进入 Agent 内置运行目录，不能伪装为已接线。`,
        code: "RUNTIME_NOT_CONNECTED",
      });
      return;
    }
    const command = `/${skill.commandName} `;
    router.push(`/tools/text/text-chat?command=${encodeURIComponent(command)}`);
  }

  function openSkillCreator(mode: "create" | "adapt") {
    const request = mode === "create"
      ? "/skill-creator 我想创建一个新的 Skill，请先引导我梳理用途、触发条件、输入和输出。"
      : "/skill-creator 我需要导入并适配第三方 Skill，请先说明需要提供的文件和兼容要求。";
    router.push(`/tools/text/text-chat?command=${encodeURIComponent(request)}`);
  }

  async function changeInstallation(skill: SkillViewModel, install: boolean) {
    if (!skill.package) {
      setNotice({
        tone: "warning",
        message: `「${skill.title}」来自内置 Skill 目录，当前没有可安装的发布包；它仍可在 Agent 中直接调用。`,
        code: "BUILTIN_CATALOG_ONLY",
      });
      return;
    }
    if (!state.auth.token) {
      setNotice({
        tone: "error",
        message: `请先登录后${install ? "安装" : "卸载"} Skill；本页不会在浏览器本地伪造安装状态。`,
        code: "AUTH_REQUIRED",
      });
      return;
    }
    setPendingPackageId(skill.package.packageId);
    try {
      if (install) await installPublishedSkill(skill.package.packageId, state.auth.token);
      else await uninstallPublishedSkill(skill.package.packageId, state.auth.token);
      const refreshed = await refreshCatalog(undefined, true);
      if (refreshed) {
        setNotice({
          tone: "success",
          message: install
            ? `已通过 Skill 包服务安装「${skill.title}」。`
            : `已通过 Skill 包服务卸载「${skill.title}」。`,
        });
      }
    } catch (error) {
      const described = describeSkillApiError(error);
      if (described.fallbackToBuiltin) {
        setPublishedPackages([]);
        setCatalogMode("builtin");
      }
      setNotice({ tone: described.fallbackToBuiltin ? "warning" : "error", message: described.message, code: described.code });
    } finally {
      setPendingPackageId(null);
    }
  }

  const noticeIcon = notice.tone === "success"
    ? <Check size={15} />
    : notice.tone === "info"
      ? <LoaderCircle className={catalogMode === "loading" ? styles.spinning : undefined} size={15} />
      : <AlertCircle size={15} />;

  return (
    <div className={styles.page} data-testid="youcai-skill-expert-page">
      <header className={styles.hero}>
        <div className={styles.eyebrow}><Sparkles size={15} />SKILL 专家</div>
        <div className={styles.heroRow}>
          <div>
            <h1>把专业方法装进你的创作 Agent</h1>
            <p>浏览真实发布包与内置目录。输入 <code>/skill-name</code> 可指定内置 Skill，也可由 Agent 根据需求自动选择。</p>
          </div>
          <div className={styles.heroActions}>
            <button type="button" onClick={() => openSkillCreator("adapt")}>
              <Upload size={16} />导入 Skill
            </button>
            <button type="button" data-primary="true" onClick={() => openSkillCreator("create")}>
              <Bot size={16} />通过 Agent 创建
            </button>
          </div>
        </div>
      </header>

      <div className={styles.catalogBanner} data-mode={catalogMode}>
        <span>{catalogMode === "published" ? <ShieldCheck size={18} /> : catalogMode === "loading" ? <LoaderCircle className={styles.spinning} size={18} /> : <PackageCheck size={18} />}</span>
        <div>
          <strong>{catalogMode === "published" ? "已发布 Skill 包目录" : catalogMode === "loading" ? "正在核验 Skill 包目录" : "内置 Skill 目录"}</strong>
          <p>{catalogMode === "published"
            ? "安装状态、发布版本、来源、权限与输出契约均来自服务端；内置 36 项继续保障 Agent 命令可用。"
            : catalogMode === "loading"
              ? "正在读取账号可用的 Skill 目录。"
              : "账号 Skill 服务暂时不可用。当前仍可浏览内置目录，安装状态以服务恢复后的账号记录为准。"}</p>
        </div>
        <button type="button" disabled={catalogMode === "loading"} onClick={() => void refreshCatalog()}><RefreshCw size={14} />重新核验</button>
      </div>

      <section className={styles.controls} aria-label="Skill 筛选">
        <div className={styles.controlTopline}>
          <div className={styles.tabs} role="tablist" aria-label="Skill 页面">
            <button type="button" role="tab" aria-selected={tab === "store"} data-active={tab === "store" ? "true" : undefined} onClick={() => setTab("store")}>
              <Store size={16} />Skill 目录 <small>{skills.length}</small>
            </button>
            <button type="button" role="tab" aria-selected={tab === "mine"} data-active={tab === "mine" ? "true" : undefined} onClick={() => setTab("mine")}>
              <PackageCheck size={16} />我的安装 <small>{mineCount}</small>
            </button>
          </div>
          <label className={styles.searchBox}>
            <Search size={17} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索能力、命令或 Skill 名称" />
          </label>
        </div>

        <div className={styles.filterRow}>
          <strong>来源</strong>
          {([
            ["all", `全部来源 ${skills.length}`],
            ["official", `平台目录 ${officialCount}`],
            ["community", `公开分享 ${communityCount}`],
          ] as const).map(([value, label]) => (
            <button type="button" key={value} data-active={source === value ? "true" : undefined} onClick={() => setSource(value)}>{label}</button>
          ))}
        </div>

        <div className={styles.filterRow}>
          <strong>分类</strong>
          <button type="button" data-active={category === "all" ? "true" : undefined} onClick={() => setCategory("all")}>全部分类</button>
          {YOUCAI_SKILL_CATEGORIES.map((item) => (
            <button type="button" key={item.value} data-active={category === item.value ? "true" : undefined} onClick={() => setCategory(item.value)}>{item.label}</button>
          ))}
        </div>

        <div className={styles.filterRow}>
          <strong>标签</strong>
          <button type="button" data-active={tag === "all" ? "true" : undefined} onClick={() => setTag("all")}>全部标签</button>
          {YOUCAI_SKILL_TAGS.map((item) => (
            <button type="button" key={item} data-active={tag === item ? "true" : undefined} onClick={() => setTag(item)}>{item}</button>
          ))}
        </div>
      </section>

      <div className={styles.status} data-tone={notice.tone} role="status">
        {noticeIcon}<span>{notice.message}</span>{notice.code ? <code>{notice.code}</code> : null}
      </div>

      <section className={styles.resultSection}>
        <div className={styles.sectionTitle}>
          <div>
            <span>{source === "community" ? <WandSparkles size={18} /> : <BadgeCheck size={18} />}</span>
            <div>
              <h2>{tab === "mine" ? "我的安装" : catalogMode === "published" ? "发布包与内置能力" : "内置 Skill 目录"}</h2>
              <p>{tab === "mine"
                ? "这里只显示服务端确认的用户安装记录，不把内置目录伪装成已安装。"
                : "36 项内置能力可直接进入 Agent；发布包另行提供可审计的版本、权限与安装生命周期。"}</p>
            </div>
          </div>
          <strong>{visibleSkills.length} 个可见</strong>
        </div>

        {visibleSkills.length === 0 ? (
          <div className={styles.emptyState}>
            <Search size={25} />
            <strong>{tab === "mine" && catalogMode !== "published" ? "尚未连接安装记录" : tab === "mine" ? "暂无已安装 Skill 包" : "没有匹配的 Skill"}</strong>
            <span>{tab === "mine" ? "安装状态只以服务端为准；内置目录能力仍可在 Agent 中使用。" : "尝试清空搜索词或切换来源、分类和标签。"}</span>
          </div>
        ) : (
          <div className={styles.skillGrid}>
            {visibleSkills.map((skill) => {
              const pending = pendingPackageId === skill.package?.packageId;
              return (
                <article className={styles.skillCard} data-category={skill.category} data-testid="youcai-skill-card" key={skill.key}>
                  <button className={styles.cardMain} type="button" onClick={() => setSelectedKey(skill.key)} aria-label={`查看 ${skill.title} 详情`}>
                    <span className={styles.skillIcon}><WandSparkles size={22} /></span>
                    <span className={styles.cardCopy}>
                      <span className={styles.cardHeading}>
                        <strong>{skill.title}</strong>
                        <small data-source={skill.sourceGroup}>{skill.sourceLabel}</small>
                      </span>
                      <code>/{skill.commandName}</code>
                      <p>{compactSummary(skill.summary)}</p>
                      <span className={styles.tags}>{skill.tags.slice(0, 3).map((item) => <em key={item}>{item}</em>)}</span>
                    </span>
                  </button>
                  <footer>
                    <span>{skill.package
                      ? `${skill.installed ? "已安装" : "已发布"} · v${skill.version}`
                      : `内置目录 · v${skill.version}`}</span>
                    <div className={styles.cardFooterActions}>
                      {skill.package && !skill.installed ? (
                        <button type="button" disabled={pending} onClick={() => void changeInstallation(skill, true)}>
                          {pending ? <LoaderCircle className={styles.spinning} size={14} /> : <Download size={14} />}安装
                        </button>
                      ) : null}
                      {skill.agentReady ? <button type="button" onClick={() => openAgentWithCommand(skill)}>去创作</button> : null}
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {selectedSkill ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setSelectedKey(null);
        }}>
          <section className={styles.detailModal} role="dialog" aria-modal="true" aria-labelledby="skill-detail-title">
            <button className={styles.closeButton} type="button" aria-label="关闭 Skill 详情" onClick={() => setSelectedKey(null)}><X size={19} /></button>
            <div className={styles.detailHeader} data-category={selectedSkill.category}>
              <span className={styles.skillIcon}><WandSparkles size={24} /></span>
              <div>
                <span>{selectedSkill.package ? selectedSkill.sourceLabel : "内置 Skill 目录"}</span>
                <h2 id="skill-detail-title">{selectedSkill.title}</h2>
                <code>/{selectedSkill.commandName}</code>
              </div>
            </div>
            <div className={styles.detailBody}>
              <div className={styles.detailMeta}>
                <span>分类：{selectedSkill.categoryLabel}</span>
                <span>发布版本：{selectedSkill.package ? selectedSkill.version : "未发布（内置目录）"}</span>
                <span>作者：{selectedSkill.author}</span>
                <span>安装状态：{selectedSkill.package ? selectedSkill.installed ? "已安装" : "未安装" : "无发布包"}</span>
                <span>运行类型：{selectedSkill.package?.runtimeKind || "prompt（内置）"}</span>
                <span>调用计价：{selectedSkill.priceCredits > 0 ? `${selectedSkill.priceCredits} 积分` : "Skill 本身 0 积分；模型另计"}</span>
              </div>
              <div className={styles.detailBlock}>
                <h3>能力说明</h3>
                <p>{selectedSkill.summary}</p>
              </div>
              <div className={styles.detailBlock}>
                <h3>执行边界</h3>
                <p>{selectedSkill.contract}</p>
              </div>
              <div className={styles.detailBlock}>
                <h3>来源与版本</h3>
                {selectedSkill.package ? (
                  <p>
                    {selectedSkill.sourceLabel} · v{selectedSkill.version} · 发布于 {formatPublishedAt(selectedSkill.package.publishedAt)}；
                    来源：{normalizeWorkspaceBrand(selectedSkill.package.provenance.sourceName)}；
                    许可证：{selectedSkill.package.provenance.license || "未提供"}；
                    {selectedSkill.package.provenance.publicBehaviorReference || "仅依据公开行为与本项目原创实现。"}
                  </p>
                ) : <p>当前能力只来自本项目内置 36 项运行目录；没有服务端发布包、用户安装记录或第三方隐藏提示词。</p>}
              </div>
              <div className={styles.detailBlock}>
                <h3>权限要求</h3>
                <p>{selectedSkill.package ? permissionSummary(selectedSkill.package) : "内置提示词能力；实际模型与媒体权限由进入的主站工作台校验。"}</p>
              </div>
              <div className={styles.detailBlock}>
                <h3>公开输出契约</h3>
                <p>{selectedSkill.package ? schemaSummary(selectedSkill.package.outputSchema) : selectedSkill.contract}</p>
              </div>
              <div className={styles.detailBlock}>
                <h3>Agent 调用方式</h3>
                <p>{selectedSkill.agentReady
                  ? <>在创作 Agent 输入 <code>/{selectedSkill.commandName} 你的需求</code>；内置 Skill 允许 Agent 根据语义选择。</>
                  : "该发布包尚未同步到 Agent 的内置运行目录，安装不等于已经具备运行时能力。"}</p>
              </div>
              <div className={styles.detailTags}>{selectedSkill.tags.map((item) => <span key={item}>{item}</span>)}</div>
            </div>
            <footer className={styles.detailActions}>
              {selectedSkill.package?.installed ? (
                <button type="button" disabled={pendingPackageId === selectedSkill.package.packageId} onClick={() => void changeInstallation(selectedSkill, false)}>
                  {pendingPackageId === selectedSkill.package.packageId ? <LoaderCircle className={styles.spinning} size={15} /> : null}卸载 Skill
                </button>
              ) : null}
              {selectedSkill.package && !selectedSkill.installed ? (
                <button type="button" data-primary="true" disabled={pendingPackageId === selectedSkill.package.packageId} onClick={() => void changeInstallation(selectedSkill, true)}>
                  {pendingPackageId === selectedSkill.package.packageId ? <LoaderCircle className={styles.spinning} size={15} /> : <Download size={15} />}安装 Skill
                </button>
              ) : selectedSkill.agentReady ? (
                <button type="button" data-primary="true" onClick={() => openAgentWithCommand(selectedSkill)}><Bot size={15} />在 Agent 中创作</button>
              ) : null}
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
