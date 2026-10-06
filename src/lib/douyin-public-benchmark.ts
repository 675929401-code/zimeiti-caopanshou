type UnknownRecord = Record<string, unknown>;

export type DouyinPublicPost = {
  aweme_id: string;
  url: string;
  description: string;
  create_time: number | null;
  duration_ms: number | null;
  cover: string | null;
  hashtags: string[];
  author: {
    nickname: string | null;
    douyin_id: string | null;
    sec_uid: string | null;
  };
  author_match_status: "matched" | "unknown" | "mismatched";
  statistics: {
    likes: number | null;
    comments: number | null;
    collects: number | null;
    shares: number | null;
    plays: number | null;
  };
};

export type DouyinPublicBenchmarkResult = {
  success: boolean;
  access_mode: "public_page_free" | "user_browser_capture_free";
  evidence_status: "complete_sample" | "partial_sample" | "blocked";
  requested_url: string;
  final_url: string;
  collected_at: string;
  profile: {
    nickname: string | null;
    douyin_id: string | null;
    signature: string | null;
    sec_uid: string | null;
    follower_count: number | null;
    following_count: number | null;
    total_favorited: number | null;
    aweme_count: number | null;
    ip_location: string | null;
  };
  posts: DouyinPublicPost[];
  sample_summary: {
    requested: number;
    collected: number;
    with_public_metrics: number;
    with_description: number;
    author_matched: number;
    author_unknown: number;
    author_excluded: number;
  };
  visible_page_text: string;
  limitations: string[];
  next_input_needed: string[];
  untrusted_content_notice?: string;
};

const ALLOWED_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "v.douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com",
]);

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const normalized = asNumber(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function firstUrl(value: unknown): string | null {
  const direct = asString(value);
  if (direct?.startsWith("http")) return direct;
  const record = asRecord(value);
  const urlList = record?.url_list;
  if (Array.isArray(urlList)) {
    return urlList.map(asString).find((item): item is string => Boolean(item?.startsWith("http"))) || null;
  }
  return null;
}

function normalizeDouyinUrl(rawUrl: string): string {
  const candidate = rawUrl.trim().match(/https?:\/\/[^\s]+/i)?.[0] || rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("请输入完整的抖音主页或公开视频链接");
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error("免费采集技能仅接受 douyin.com 官方域名链接");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("链接协议不受支持");
  }
  return parsed.toString();
}

function collectStructuredObjects(payloads: unknown[]) {
  const awemes: UnknownRecord[] = [];
  const users: UnknownRecord[] = [];
  const visited = new Set<object>();
  let visitedCount = 0;

  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || visitedCount > 40_000 || !value || typeof value !== "object") return;
    if (visited.has(value as object)) return;
    visited.add(value as object);
    visitedCount += 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as UnknownRecord;
    if (record.aweme_id && (record.desc !== undefined || record.statistics || record.video)) awemes.push(record);
    if ((record.nickname || record.unique_id) && (record.follower_count !== undefined || record.sec_uid || record.signature !== undefined)) users.push(record);
    for (const child of Object.values(record)) walk(child, depth + 1);
  };

  for (const payload of payloads) walk(payload, 0);
  return { awemes, users };
}

type PublicProfile = DouyinPublicBenchmarkResult["profile"];

function normalizedIdentity(value: string | null): string {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function authorMatchStatus(author: DouyinPublicPost["author"], profile: PublicProfile): DouyinPublicPost["author_match_status"] {
  const pairs = [
    [author.sec_uid, profile.sec_uid],
    [author.douyin_id, profile.douyin_id],
    [author.nickname, profile.nickname],
  ].filter(([left, right]) => Boolean(left && right));
  if (pairs.some(([left, right]) => normalizedIdentity(left) === normalizedIdentity(right))) return "matched";
  return pairs.length > 0 ? "mismatched" : "unknown";
}

function normalizePost(item: UnknownRecord, profile: PublicProfile): DouyinPublicPost | null {
  const id = firstString(item.aweme_id, item.item_id, item.id);
  if (!id) return null;
  const statistics = asRecord(item.statistics) || {};
  const video = asRecord(item.video) || {};
  const cover = firstUrl(video.cover) || firstUrl(video.origin_cover) || firstUrl(item.cover);
  const textExtra = Array.isArray(item.text_extra) ? item.text_extra : [];
  const rawAuthor = asRecord(item.author) || {};
  const author = {
    nickname: firstString(rawAuthor.nickname),
    douyin_id: firstString(rawAuthor.unique_id, rawAuthor.short_id),
    sec_uid: firstString(rawAuthor.sec_uid),
  };
  const hashtags = textExtra
    .map((entry) => firstString(asRecord(entry)?.hashtag_name))
    .filter((entry): entry is string => Boolean(entry));
  return {
    aweme_id: id,
    url: `https://www.douyin.com/video/${id}`,
    description: firstString(item.desc, item.caption, item.title) || "",
    create_time: firstNumber(item.create_time),
    duration_ms: firstNumber(item.duration, video.duration),
    cover,
    hashtags: [...new Set(hashtags)],
    author,
    author_match_status: authorMatchStatus(author, profile),
    statistics: {
      likes: firstNumber(statistics.digg_count, item.digg_count),
      comments: firstNumber(statistics.comment_count, item.comment_count),
      collects: firstNumber(statistics.collect_count, item.collect_count),
      shares: firstNumber(statistics.share_count, item.share_count),
      plays: firstNumber(statistics.play_count, item.play_count),
    },
  };
}

function normalizeProfile(users: UnknownRecord[], posts: UnknownRecord[]) {
  const candidates = [...users];
  for (const post of posts) {
    const author = asRecord(post.author);
    if (author) candidates.push(author);
  }
  const score = (item: UnknownRecord) => [
    item.nickname, item.unique_id, item.signature, item.sec_uid,
    item.follower_count, item.aweme_count, item.total_favorited,
  ].filter((value) => value !== undefined && value !== null && value !== "").length;
  const best = [...candidates].sort((a, b) => score(b) - score(a))[0] || {};
  return {
    nickname: firstString(best.nickname),
    douyin_id: firstString(best.unique_id, best.short_id),
    signature: firstString(best.signature),
    sec_uid: firstString(best.sec_uid),
    follower_count: firstNumber(best.follower_count),
    following_count: firstNumber(best.following_count),
    total_favorited: firstNumber(best.total_favorited, best.total_favorited_new),
    aweme_count: firstNumber(best.aweme_count),
    ip_location: firstString(best.ip_location),
  };
}

export async function collectDouyinPublicBenchmark(
  rawUrl: string,
  requestedLimit = 20,
): Promise<DouyinPublicBenchmarkResult> {
  const requestedUrl = normalizeDouyinUrl(rawUrl);
  const limit = Math.min(Math.max(Math.round(requestedLimit || 20), 5), 30);
  const { chromium } = await import("playwright");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
    ],
  });
  const payloads: unknown[] = [];
  const responseTasks: Promise<void>[] = [];
  let finalUrl = requestedUrl;
  let visiblePageText = "";

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.on("response", (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (!/(?:aweme\/post|aweme\/detail|user\/profile|user\/detail|mix\/aweme)/i.test(url)) return;
      if (!contentType.includes("json")) return;
      responseTasks.push(response.json().then((payload) => { payloads.push(payload); }).catch(() => undefined));
    });

    await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.mouse.wheel(0, 5_000);
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
          if (element.scrollHeight > element.clientHeight + 400) element.scrollTop = element.scrollHeight;
        }
      }).catch(() => undefined);
      await page.waitForTimeout(900);
    }
    finalUrl = page.url();
    visiblePageText = (await page.locator("body").innerText().catch(() => "")).slice(0, 12_000);

    const embeddedPayloads = await page.locator("script").evaluateAll((scripts) => scripts
      .map((script) => script.textContent || "")
      .filter((text) => text.trim().startsWith("{") && text.length < 5_000_000)
      .slice(0, 20));
    for (const raw of embeddedPayloads) {
      try { payloads.push(JSON.parse(raw)); } catch { /* public page scripts are not always plain JSON */ }
    }
    await Promise.allSettled(responseTasks);
    await context.close();
  } finally {
    await browser.close();
  }

  const { awemes, users } = collectStructuredObjects(payloads);
  const profile = normalizeProfile(users, awemes);
  const postMap = new Map<string, DouyinPublicPost>();
  let authorExcluded = 0;
  for (const item of awemes) {
    const post = normalizePost(item, profile);
    if (post?.author_match_status === "mismatched") {
      authorExcluded += 1;
      continue;
    }
    if (post && !postMap.has(post.aweme_id)) postMap.set(post.aweme_id, post);
  }
  const posts = [...postMap.values()]
    .sort((a, b) => (b.create_time || 0) - (a.create_time || 0))
    .slice(0, limit);
  const hasProfile = Object.values(profile).some((value) => value !== null);
  const isBlocked = !hasProfile && posts.length === 0;
  const evidenceStatus = isBlocked ? "blocked" : posts.length >= Math.min(limit, 10) ? "complete_sample" : "partial_sample";
  const limitations = [
    "这是免费公开页面采样，不是抖音官方授权数据接口。",
    "只能分析采集时公开且页面允许访问的信息，无法保证覆盖账号全部历史作品。",
    "粉丝历史增长、完播率、播放量、私密作品、删除作品和后台受众数据无法从任意对标账号公开取得。",
    "作品描述不等于完整口播稿；没有公开字幕时，文案风格结论只能按标题、描述和用户补充文本判断。",
    "作者字段缺失的作品会标为作者待确认；作者明确不匹配的推荐作品不会进入正式样本。",
  ];
  const nextInputNeeded: string[] = [];
  if (isBlocked) nextInputNeeded.push("主页截图（昵称、简介、粉丝量、作品列表）");
  if (posts.length < 10) nextInputNeeded.push("补充10至30条代表作品链接或作品列表截图");
  if (posts.filter((post) => post.description).length < 5) nextInputNeeded.push("粘贴5至10篇口播文案或公开视频字幕");
  if (posts.some((post) => post.author_match_status === "unknown")) nextInputNeeded.push("核对作者待确认作品是否属于目标账号");

  return {
    success: !isBlocked,
    access_mode: "public_page_free",
    evidence_status: evidenceStatus,
    requested_url: requestedUrl,
    final_url: finalUrl,
    collected_at: new Date().toISOString(),
    profile,
    posts,
    sample_summary: {
      requested: limit,
      collected: posts.length,
      with_public_metrics: posts.filter((post) => Object.values(post.statistics).some((value) => value !== null)).length,
      with_description: posts.filter((post) => post.description.length > 0).length,
      author_matched: posts.filter((post) => post.author_match_status === "matched").length,
      author_unknown: posts.filter((post) => post.author_match_status === "unknown").length,
      author_excluded: authorExcluded,
    },
    visible_page_text: visiblePageText,
    limitations,
    next_input_needed: nextInputNeeded,
  };
}
