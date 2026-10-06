import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const profileUrl = process.argv[2] || "https://v.douyin.com/ytcWZku1qS4/";
const outputDir = ".tmp-e2e/douyin-benchmark";

async function main() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const jsonResponses: Array<{ url: string; status: number; body: unknown }> = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (!/(?:aweme|post|user|profile|feed)/iu.test(url)) return;
      const contentType = response.headers()["content-type"] || "";
      if (!contentType.includes("json")) return;
      try {
        jsonResponses.push({ url, status: response.status(), body: await response.json() });
      } catch {
        // Some protected responses advertise JSON but return an empty body.
      }
    });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8_000);
    const firstPostResponse = jsonResponses.find((item) => item.url.includes("/aweme/v1/web/aweme/post/"));
    if (firstPostResponse) {
      let cursor = Number((firstPostResponse.body as { max_cursor?: number }).max_cursor || 0);
      let hasMore = Boolean((firstPostResponse.body as { has_more?: number }).has_more);
      for (let index = 0; index < 5 && hasMore && cursor; index += 1) {
        const nextUrl = new URL(firstPostResponse.url);
        nextUrl.searchParams.set("max_cursor", String(cursor));
        nextUrl.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
        const response = await context.request.get(nextUrl.toString(), {
          headers: { referer: page.url() },
          timeout: 30_000,
        });
        const responseText = await response.text();
        if (!responseText.trim().startsWith("{")) break;
        const body = JSON.parse(responseText) as { max_cursor?: number; has_more?: number };
        jsonResponses.push({ url: nextUrl.toString(), status: response.status(), body });
        cursor = Number(body.max_cursor || 0);
        hasMore = Boolean(body.has_more);
      }
    }
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
          if (element.scrollHeight > element.clientHeight + 300) element.scrollTop = element.scrollHeight;
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await page.mouse.wheel(0, 10_000);
      await page.waitForTimeout(1_500);
    }
    const result = {
      requestedUrl: profileUrl,
      finalUrl: page.url(),
      title: await page.title(),
      bodyText: (await page.locator("body").innerText()).slice(0, 20_000),
      links: await page.locator("a").evaluateAll((anchors) => anchors.slice(0, 200).map((anchor) => ({
        text: (anchor.textContent || "").trim(),
        href: (anchor as HTMLAnchorElement).href,
      }))),
      jsonResponses,
    };
    await page.screenshot({ path: `${outputDir}/profile.png`, fullPage: true });
    await writeFile(`${outputDir}/profile.json`, JSON.stringify(result, null, 2), "utf8");
    console.log(JSON.stringify({
      finalUrl: result.finalUrl,
      title: result.title,
      bodyPreview: result.bodyText.slice(0, 1200),
      links: result.links.length,
      jsonResponses: result.jsonResponses.map((item) => ({ url: item.url, status: item.status })),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
