import { chromium } from "playwright";

const baseUrl = String(process.env.BASE_URL || process.env.YOUCAI_BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
const pageErrors = [];
const httpErrors = [];
const failedRequests = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
page.on("response", (response) => {
  if (response.status() < 400) return;
  httpErrors.push({
    status: response.status(),
    url: response.url(),
    resourceType: response.request().resourceType(),
  });
});
page.on("requestfailed", (request) => {
  failedRequests.push({
    url: request.url(),
    resourceType: request.resourceType(),
    reason: request.failure()?.errorText || "unknown",
  });
});

const redirectChecks = [];
for (const path of ["/youcai/navigation", "/youcai/creative-horizon", "/navigation", "/creative-horizon"]) {
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  redirectChecks.push({ path, status: response?.status() ?? null, finalPath: new URL(page.url()).pathname });
}
const response = await page.goto(`${baseUrl}/youcai`, { waitUntil: "networkidle" });
const result = {
  status: response?.status() ?? null,
  url: page.url(),
  title: await page.title(),
  bodyText: (await page.locator("body").innerText()).slice(0, 800),
  retiredLinksVisible: await page.locator('a[href*="/creative-horizon"], a[href$="/navigation"]').count(),
  redirectChecks,
  consoleErrors,
  pageErrors,
  httpErrors,
  failedRequests,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await browser.close();
