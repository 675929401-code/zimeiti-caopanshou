import "server-only";
import { z } from "zod";
import { createHash } from "node:crypto";
import { CoverStyleKeySchema, CoverStyleVersionSchema, CoverStylePublicSchema, type CoverStylePublic } from "../cover-style-catalog";
import type { CoverStyleDefinition } from "../cover-workbench-contract";
import type { CoverBenchmarkPromptPack } from "../cover-benchmark-prompt-packs";

export const COVER_STYLE_SETTING_KEY = "cover.style.catalog.v1";
export const COVER_STYLE_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const text = z.string().min(1).max(50_000).refine(value => Boolean(value.trim()), "提示词不能只有空白");
export const CoverStyleDraftInputSchema = z.object({
  displayName: z.string().trim().min(1).max(60), description: z.string().trim().max(240),
  analysisPrompt: text, generationPrompt: text,
  // Old immutable releases retain their historical augmentation. Newly edited
  // releases contain the complete business rules visible in the editor.
  completeRules: z.literal(true).optional(),
}).strict();
export type CoverStyleDraftInput = z.infer<typeof CoverStyleDraftInputSchema>;
export const CoverStyleReleaseSchema = CoverStyleDraftInputSchema.extend({
  releaseId: z.string().min(1).max(120), styleKey: CoverStyleKeySchema, version: CoverStyleVersionSchema,
  sequence: z.number().int().positive(), createdAt: z.string().datetime(), createdBy: z.string().min(1).max(100),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type CoverStyleRelease = z.infer<typeof CoverStyleReleaseSchema>;
const pointer = z.object({ releaseId: z.string().min(1).max(120), publishedAt: z.string().datetime(), publishedBy: z.string().min(1).max(100) }).strict();
export const CoverWorkflowDraftInputSchema = z.object({
  sharedRules: z.string().min(1).max(16_000).refine(value => Boolean(value.trim()), "共用拆解规则不能只有空白"),
  textModelId: z.string().min(1).max(200).nullable(),
  imageModelId: z.string().min(1).max(200).nullable(),
}).strict();
export type CoverWorkflowDraftInput = z.infer<typeof CoverWorkflowDraftInputSchema>;
export const CoverWorkflowReleaseSchema = CoverWorkflowDraftInputSchema.extend({
  releaseId: z.string().min(1).max(120), version: CoverStyleVersionSchema,
  sequence: z.number().int().positive(), createdAt: z.string().datetime(), createdBy: z.string().min(1).max(100),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type CoverWorkflowRelease = z.infer<typeof CoverWorkflowReleaseSchema>;
const workflow = z.object({
  draftReleaseId: z.string().max(120).nullable(), current: pointer.nullable(),
  releases: z.array(CoverWorkflowReleaseSchema).max(1000),
  publications: z.array(pointer.extend({ action: z.enum(["publish", "rollback"]) }).strict()).max(2000),
}).strict();
const entry = z.object({
  styleKey: CoverStyleKeySchema, enabled: z.boolean(), order: z.number().int().min(0).max(100_000),
  draftReleaseId: z.string().max(120).nullable(), current: pointer.nullable(),
  releases: z.array(CoverStyleReleaseSchema).max(1000),
  publications: z.array(pointer.extend({ action: z.enum(["publish", "rollback"]) }).strict()).max(2000),
}).strict();
export const CoverStyleCatalogSchema = z.object({
  schemaVersion: z.literal("cover-style-catalog/1"), revision: z.number().int().nonnegative(), entries: z.array(entry).max(40),
  workflow: workflow.optional(),
  audit: z.array(z.object({ revision: z.number().int().positive(), action: z.enum(["draft", "publish", "rollback", "set-enabled", "reorder", "workflow-draft", "workflow-publish", "workflow-rollback"]),
    styleKey: CoverStyleKeySchema.nullable(), releaseId: z.string().max(120).nullable(), actorId: z.string().min(1).max(100), at: z.string().datetime() }).strict()).max(4000),
}).strict();
export type CoverStyleCatalog = z.infer<typeof CoverStyleCatalogSchema>;
export type CoverStyleRuntime = {
  style: CoverStyleDefinition;
  release: CoverStyleRelease & { publishedAt: string };
  promptPack: CoverBenchmarkPromptPack;
  sceneBriefVersion?: 1;
};
export class CoverStyleStoreError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409, readonly outcome?: "unknown") { super(message); this.name = "CoverStyleStoreError"; }
}
export function coverStyleStableJson(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : item;
  return JSON.stringify(stable(value));
}
export function coverStyleHash(value: unknown): string { return createHash("sha256").update(coverStyleStableJson(value)).digest("hex"); }
export function coverStyleReleaseHash(release: Omit<CoverStyleRelease, "snapshotSha256"> | CoverStyleRelease): string {
  const { snapshotSha256: _hash, ...payload } = release as CoverStyleRelease;
  void _hash;
  return coverStyleHash(payload);
}
export function coverWorkflowReleaseHash(release: Omit<CoverWorkflowRelease, "snapshotSha256"> | CoverWorkflowRelease): string {
  const { snapshotSha256: _hash, ...payload } = release as CoverWorkflowRelease;
  void _hash;
  return coverStyleHash(payload);
}
export function assertCoverStyleCatalog(value: unknown): CoverStyleCatalog {
  const parsed = CoverStyleCatalogSchema.parse(value);
  if (Buffer.byteLength(coverStyleStableJson(parsed), "utf8") > COVER_STYLE_CATALOG_MAX_BYTES) throw new CoverStyleStoreError("COVER_STYLE_CAPACITY", "风格版本库已达到容量限制，旧版本保留，请先安排受控归档", 503);
  const keys = new Set<string>(), releaseIds = new Set<string>();
  for (const row of parsed.entries) {
    if (keys.has(row.styleKey)) throw new CoverStyleStoreError("COVER_STYLE_CATALOG_INVALID", "风格标识重复", 503);
    keys.add(row.styleKey);
    const versions = new Set<string>();
    for (const release of row.releases) {
      if (releaseIds.has(release.releaseId) || versions.has(release.version) || release.styleKey !== row.styleKey || release.version !== `${release.sequence}.0.0`
        || release.snapshotSha256 !== coverStyleReleaseHash(release)) throw new CoverStyleStoreError("COVER_STYLE_CATALOG_INVALID", "风格版本身份或摘要不一致", 503);
      releaseIds.add(release.releaseId); versions.add(release.version);
    }
    for (const id of [row.current?.releaseId, row.draftReleaseId, ...row.publications.map(event => event.releaseId)])
      if (id && !row.releases.some(release => release.releaseId === id)) throw new CoverStyleStoreError("COVER_STYLE_CATALOG_INVALID", "风格版本指针无效", 503);
    if (row.current && !row.publications.some(event => event.releaseId === row.current!.releaseId && event.publishedAt === row.current!.publishedAt && event.publishedBy === row.current!.publishedBy))
      throw new CoverStyleStoreError("COVER_STYLE_CATALOG_INVALID", "当前风格缺少对应发布记录", 503);
  }
  if (parsed.workflow) {
    const state = parsed.workflow, versions = new Set<string>();
    for (const release of state.releases) {
      if (releaseIds.has(release.releaseId) || versions.has(release.version) || release.version !== `${release.sequence}.0.0`
        || release.snapshotSha256 !== coverWorkflowReleaseHash(release))
        throw new CoverStyleStoreError("COVER_WORKFLOW_CATALOG_INVALID", "拆解规则版本身份或摘要不一致", 503);
      releaseIds.add(release.releaseId); versions.add(release.version);
    }
    for (const id of [state.current?.releaseId, state.draftReleaseId, ...state.publications.map(event => event.releaseId)]) {
      if (id && !state.releases.some(release => release.releaseId === id))
        throw new CoverStyleStoreError("COVER_WORKFLOW_CATALOG_INVALID", "拆解规则版本指针无效", 503);
    }
    if (!state.current || !state.publications.some(event => event.releaseId === state.current!.releaseId
      && event.publishedAt === state.current!.publishedAt && event.publishedBy === state.current!.publishedBy))
      throw new CoverStyleStoreError("COVER_WORKFLOW_CATALOG_INVALID", "当前拆解规则缺少对应发布记录", 503);
  }
  return parsed;
}
export function publicCoverStyles(catalog: CoverStyleCatalog): { styles: CoverStylePublic[]; revision: number } {
  const styles = catalog.entries.filter(row => row.enabled && row.current).map(row => {
    const release = row.releases.find(item => item.releaseId === row.current!.releaseId)!;
    return CoverStylePublicSchema.parse({ styleKey: row.styleKey, displayName: release.displayName, description: release.description, version: release.version, order: row.order });
  }).sort((a, b) => a.order - b.order || a.styleKey.localeCompare(b.styleKey));
  return { styles, revision: catalog.revision };
}
export function runtimeCoverStyle(release: CoverStyleRelease, publishedAt: string): CoverStyleRuntime {
  const typography = release.styleKey === "funny-cartoon" ? "high_contrast_reaction" : "warm_story";
  const narrative = release.styleKey === "cartoon" || release.styleKey === "funny-cartoon";
  const analysisRules = [release.analysisPrompt];
  const nativeCoverRules = [release.generationPrompt];
  if (narrative && !release.completeRules) {
    analysisRules.push(
      "先辨认口播的言外之意和叙述口吻：它希望观众心疼谁、对什么会心一笑、对哪种误会改变看法？标题与画面围绕同一个情感落点。标题候选用原文支持的具体对象加上矛盾、动作或未说破的原因，分别尝试关系、反差和问题角度；选一个即使没读全文也让人想追问的作主标题。避免只把摘要截短、三个标题换标点或靠惊吓夸大事实。用户锁定的标题逐字保留。",
      "把正文摘要与封面选镜分开。摘要说明作者说了什么；封面切入点要让没读过标题的人也能从一个瞬间看出这条内容的独特关系、选择或反差。原文有多个候选动作时，先比较它们各自能在一张无字静帧里说明什么，再选最有辨识度的一刻。结尾的结果只有在它本身就是最有表现力的动作时才采用。原文只支持一个动作时就用它，不编第二个。",
      "把选中的同一瞬间落实到已有字段：coverFocus 写出可见的触发物和主体的反应；visualBrief.subject 保留理解事件所必需的人、物或环境线索；action 给出身体朝向、视线或接触的明确对象。emotion 用可表演的反应支撑心情；scene 只留能解释事件的线索。若关键是主体之间的关系，让 layoutIntent.structure 与之相符；若道具已能说明主体的选择，无需硬加第二个角色。用原句作为证据，设想、比喻按设想、比喻表现。不能为凑反差制造新事实，也不要把多个时间点画成前后分镜。",
    );
    nativeCoverRules.push(
      "画面目标是原创角色的皮克斯式 3D 动画电影剧照（Pixar-style 3D animation）。先让角色在一个确认的瞬间做出能读懂的表演：以剪影、重心、头部倾向、眉眼与视线表现对具体对象的反应；道具和视线形成清楚的关系。造型有概括、可辨的轮廓和有体积的材质，光线服务动作。不要复制现成角色、标志或片名字样，不靠写实毛发、暖色滤镜或单纯放大眼睛代替表演。以已确认方案为准，不擅自增加角色、道具、动作或文字。",
      release.styleKey === "cartoon"
        ? "暖光叙事重在细微但可见的情感转折：让姿态、眼神与关系对象共同传递等待、选择或回应；保留适合原文的夜色、冷暖层次和安静空间。"
        : "趣味反差重在触发点与角色反应同框：用近景透视、眉眼的不对称与身体方向强化已确认的反差，保持解剖和道具位置可信。",
    );
  }
  const style: CoverStyleDefinition = { key: release.styleKey, version: release.version, displayName: release.displayName,
    researchSources: [], visualGrammar: [], palette: ["由已发布生成规则确定"], typography: { profile: typography, maxLines: 2, respectExplicitLineBreaks: true } };
  return { style, release: { ...structuredClone(release), publishedAt }, ...(narrative ? { sceneBriefVersion: 1 as const } : {}), promptPack: {
    key: release.styleKey, version: release.version, creator: "", displayName: release.displayName,
    sourceEvidence: { sampledAt: "", sampleCount: 0, report: "", matrix: "", previousProfile: "", boundary: "应用私有已发布风格配置" },
    analysisRules, nativeCoverRules, artworkRules: [],
    typographyIntent: { observations: [], engineeringChoices: [], variants: [], constraints: [] }, qaChecklist: [],
  } };
}
