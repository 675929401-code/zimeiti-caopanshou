import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const sourcePath = resolve(process.argv[2] || ".tmp-e2e/douyin-benchmark/profile.json");
const outputDir = resolve(process.argv[3] || ".tmp-e2e/douyin-benchmark/top-ten");
const sampleLimit = Math.max(1, Number(process.argv[4] || 10));

type Aweme = {
  aweme_id: string;
  desc: string;
  duration: number;
  statistics?: { digg_count?: number };
  video?: {
    width?: number;
    height?: number;
    play_addr?: { url_list?: string[] };
  };
};

async function main() {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as {
    jsonResponses: Array<{ url: string; body: { aweme_list?: Aweme[] } }>;
  };
  const allItems = source.jsonResponses
    .filter((item) => item.url.includes("/aweme/v1/web/aweme/post/"))
    .flatMap((item) => item.body.aweme_list || []);
  const uniqueItems = [...new Map(allItems.map((item) => [item.aweme_id, item])).values()];
  const topItems = uniqueItems
    .sort((left, right) => (right.statistics?.digg_count || 0) - (left.statistics?.digg_count || 0))
    .slice(0, sampleLimit);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const manifest: Array<Record<string, unknown>> = [];
  try {
    for (const [videoIndex, item] of topItems.entries()) {
      const sourceUrl = item.video?.play_addr?.url_list?.[0];
      if (!sourceUrl) continue;
      const videoResponse = await fetch(sourceUrl, { headers: { referer: "https://www.douyin.com/" } });
      if (!videoResponse.ok) throw new Error(`下载视频失败 ${item.aweme_id}: ${videoResponse.status}`);
      const videoBytes = Buffer.from(await videoResponse.arrayBuffer());
      const videoPath = resolve(outputDir, `${videoIndex + 1}-${item.aweme_id}.mp4`);
      await writeFile(videoPath, videoBytes);

      const page = await browser.newPage({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 1 });
      const routeUrl = `http://benchmark.local/${item.aweme_id}.mp4`;
      await page.route(routeUrl, async (route) => {
        const range = route.request().headers().range;
        if (!range) {
          await route.fulfill({
            status: 200,
            contentType: "video/mp4",
            headers: { "accept-ranges": "bytes", "content-length": String(videoBytes.length) },
            body: videoBytes,
          });
          return;
        }
        const match = range.match(/bytes=(\d+)-(\d*)/u);
        const start = Number(match?.[1] || 0);
        const requestedEnd = match?.[2] ? Number(match[2]) : videoBytes.length - 1;
        const end = Math.min(requestedEnd, videoBytes.length - 1);
        const chunk = videoBytes.subarray(start, end + 1);
        await route.fulfill({
          status: 206,
          contentType: "video/mp4",
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${videoBytes.length}`,
            "content-length": String(chunk.length),
          },
          body: chunk,
        });
      });
      await page.setContent(`<style>html,body{margin:0;background:#09090b}video{display:block;width:720px;height:1280px;object-fit:contain}</style><video muted playsinline preload="auto" src="${routeUrl}"></video>`);
      await page.waitForFunction(() => Boolean((document.querySelector("video") as HTMLVideoElement | null)?.readyState));
      const duration = await page.locator("video").evaluate((video: HTMLVideoElement) => video.duration);
      const sampleTimes = Array.from({ length: 8 }, (_, index) => Math.max(0, Math.min(duration - 0.12, duration * (index / 7))));
      const frames: string[] = [];
      for (const [frameIndex, time] of sampleTimes.entries()) {
        await page.locator("video").evaluate((video: HTMLVideoElement, seekTime) => { video.currentTime = seekTime; }, time);
        await page.waitForFunction((seekTime) => {
          const video = document.querySelector("video") as HTMLVideoElement | null;
          return Boolean(video && Math.abs(video.currentTime - seekTime) < 0.12 && video.readyState >= 2);
        }, time);
        const framePath = resolve(outputDir, `${videoIndex + 1}-${item.aweme_id}-frame-${frameIndex + 1}.png`);
        await page.locator("video").screenshot({ path: framePath });
        frames.push(framePath);
      }
      await page.close();
      manifest.push({
        rankInPublicSample: videoIndex + 1,
        id: item.aweme_id,
        likes: item.statistics?.digg_count || 0,
        durationSeconds: Number(duration.toFixed(2)),
        sourceWidth: item.video?.width,
        sourceHeight: item.video?.height,
        description: item.desc,
        videoPath,
        frames,
      });
    }
  } finally {
    await browser.close();
  }
  await writeFile(resolve(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest.map(({ rankInPublicSample, id, likes, durationSeconds, description }) => ({
    rankInPublicSample,
    id,
    likes,
    durationSeconds,
    description,
  })), null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
