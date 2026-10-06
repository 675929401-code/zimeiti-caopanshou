import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const origin = "https://youcai.art";
const outputDir = path.resolve(".codex-artifacts", "20260824-official-route-map");
const categoryRoutes = ["text", "image", "audio", "video"] as const;

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const discoveryPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const discovered = new Map<string, { category: string; label: string; href: string }>();

  for (const category of categoryRoutes) {
    await discoveryPage.goto(`${origin}/tools/${category}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await discoveryPage.waitForTimeout(900);
    const links = await discoveryPage.locator("a").evaluateAll((elements) => elements.map((element) => ({
      label: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
      href: (element as HTMLAnchorElement).href,
    })));
    for (const link of links) {
      const url = new URL(link.href);
      if (url.origin !== origin) continue;
      if (!url.pathname.startsWith(`/tools/${category}/`)) continue;
      if (!link.label) continue;
      discovered.set(url.href, { category, label: link.label, href: url.href });
    }
  }
  assert.ok(discovered.size > 0, "创作中心没有发现工具卡片路由");

  const queue = [...discovered.values()];
  const results: Array<{
    category: string;
    label: string;
    href: string;
    status: number | null;
    finalUrl: string;
    title: string;
    heading: string;
    requiresLogin: boolean;
    loadError?: string;
  }> = [];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (;;) {
      const item = queue.shift();
      if (!item) break;
      let status: number | null = null;
      let loadError: string | undefined;
      try {
        const response = await page.goto(item.href, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        status = response?.status() ?? null;
        await page.waitForTimeout(350);
      } catch (error) {
        loadError = error instanceof Error ? error.message : String(error);
      }
      const finalUrl = page.url();
      const heading = normalize(
        await page.locator("h1, h2").first().innerText().catch(() => ""),
      );
      results.push({
        ...item,
        status,
        finalUrl,
        title: await page.title().catch(() => ""),
        heading,
        requiresLogin: new URL(finalUrl).pathname === "/login",
        loadError,
      });
    }
    await page.close();
  });
  await Promise.all(workers);
  results.sort((left, right) => left.href.localeCompare(right.href));

  const primaryRoutes = [
    { label: "Skill 专家", href: `${origin}/skills` },
    { label: "创作中心", href: `${origin}/tools` },
    { label: "创作 Agent", href: `${origin}/tools/chat` },
    { label: "影视工坊", href: `${origin}/tools/film-studio` },
    { label: "有彩画布", href: `${origin}/tools/canvas` },
    { label: "灵感广场", href: `${origin}/inspiration` },
  ];
  const report = {
    ok: results.every((result) => !result.loadError && result.status !== null),
    capturedAt: new Date().toISOString(),
    source: "official public navigation and real HTTP page loads",
    primaryRoutes,
    counts: {
      totalToolCards: results.length,
      byCategory: Object.fromEntries(categoryRoutes.map((category) => [
        category,
        results.filter((result) => result.category === category).length,
      ])),
      loginProtected: results.filter((result) => result.requiresLogin).length,
      loadErrors: results.filter((result) => result.loadError).length,
    },
    tools: results,
    safety: {
      formsSubmitted: 0,
      messagesSent: 0,
      mediaGenerated: 0,
      creditsSpent: 0,
    },
  };
  fs.writeFileSync(path.join(outputDir, "official-route-map.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await discoveryPage.close();
  await browser.close();
}

void main();
