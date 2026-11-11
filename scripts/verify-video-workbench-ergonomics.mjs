import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const page = read("src/app/video/page.tsx");
const layout = read("src/app/video/paired-layout.module.css");
const route = read("src/app/api/video/models/route.ts");
const badge = read("src/components/model-badge.tsx");
const badgeStyles = read("src/components/model-badge.module.css");
const brand = read("src/lib/model-brand.ts");

const checks = [
  ["catalog remains compatible with the deployed video schema", !route.includes("avatar_url, icon_url")],
  ["video workbench uses the shared model badge", page.includes('import { ModelBadge } from "@/components/model-badge"') && page.includes("<ModelBadge")],
  ["configured avatar is passed to the shared badge", page.includes("avatarUrl={model.avatarUrl}")],
  ["model identity is passed for brand fallback", page.includes("identity={[model.displayName, model.provider, model.id]}")],
  ["shared badge uses the ordered avatar, brand and generic candidates", badge.includes("resolveModelBadgeAppearance(name, avatarUrl, identity)") && /kind: "avatar"[\s\S]*kind: "brand"[\s\S]*kind: "generic"/u.test(brand.slice(brand.indexOf("export function resolveModelBadgeAppearance"))) && badge.includes('data-model-badge-source={renderedKind}')],
  ["broken images fall through to the next candidate then to the initial", badge.includes("candidates.find(({ source }) => !failedSources.includes(source))") && badge.includes("setFailedSources((sources)") && badge.includes('<span className={styles.initial}>{initial}</span>')],
  ["brand resolver covers configured video families", ["google", "openai", "bytedance", "xai"].every((value) => brand.includes(`return "${value}"`))],
  ["model cards expose badge state markers", page.includes('data-video-model-avatar="true"') && badge.includes("data-selected=") && badge.includes("data-availability=")],
  ["model badge has a full 44px plate and 38px brand mark", /width:\s*44px[\s\S]*height:\s*44px/u.test(badgeStyles) && /\.image\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;/u.test(badgeStyles)],
  ["model badge stays readable in dark mode", badgeStyles.includes(':global(html[data-mode="dark"]) .badge')],
  ["video model typography keeps the 14/12 hierarchy", page.includes('text-[14px] font-semibold') && page.includes('text-[12px] leading-4')],
  ["creator uses wider ergonomic rail", page.includes('max-w-[1760px]') && page.includes('xl:w-[312px]')],
  ["public task cards reserve empty tracks up to three per row", page.includes('pairedLayout.taskGrid') && layout.includes('.creator .taskGrid') && layout.includes('repeat(auto-fill,') && layout.includes('var(--third-of-row)')],
  ["creator content keeps a flexible desktop rail", page.includes("flex flex-col items-stretch gap-4 xl:flex-row xl:items-start") && page.includes('className="w-full min-w-0 flex-1"')],
  ["desktop action bar can wrap safely", page.includes('className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3"')],
  ["task cards use compact radius", page.includes("data-video-task-card") && page.includes("rounded-lg border bg-[var(--card)]")],
  ["configuration controls follow theme tokens", !page.includes("#0b1728") && !page.includes("#29425b")],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (failed.length > 0) process.exitCode = 1;
else console.log(`Video workbench ergonomics contract passed (${checks.length}/${checks.length}).`);
