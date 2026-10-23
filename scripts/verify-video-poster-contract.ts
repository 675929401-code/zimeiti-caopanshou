import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coverFor, safePoster } from "../src/lib/video-poster.ts";

const taskId = "task_poster_01";
const ticketUrl = `/api/video/thumbnail/${taskId}?media_ticket=ticket_value`;
const bareUrl = `/api/video/thumbnail/${taskId}`;

assert.equal(safePoster(ticketUrl), ticketUrl, "same-origin thumbnail with media_ticket must pass");
assert.equal(safePoster(bareUrl), "", "bare thumbnail URL must not be used as a primary poster");
assert.equal(safePoster("https://cdn.example.com/frame.jpg"), "https://cdn.example.com/frame.jpg");
assert.equal(safePoster("http://cdn.example.com/frame.jpg"), "");
assert.equal(safePoster("blob:http://127.0.0.1:5000/local-poster"), "blob:http://127.0.0.1:5000/local-poster");
assert.equal(safePoster("//evil.example/api/video/thumbnail/x?media_ticket=1"), "");

assert.equal(coverFor({
  posterUrl: ticketUrl,
  firstFrameUrl: "https://cdn.example.com/frame.jpg",
  taskId,
  completed: true,
}), ticketUrl, "coverFor must prefer the ticketed thumbnail");

assert.equal(coverFor({
  localPoster: "blob:http://127.0.0.1:5000/local-poster",
  posterUrl: ticketUrl,
  taskId,
  completed: true,
}), "blob:http://127.0.0.1:5000/local-poster", "local poster still wins when present");

assert.equal(coverFor({
  posterUrl: bareUrl,
  firstFrameUrl: "https://cdn.example.com/frame.jpg",
  taskId,
  completed: true,
}), "https://cdn.example.com/frame.jpg", "a stripped bare thumbnail falls through to a safe frame");

assert.equal(coverFor({
  posterUrl: bareUrl,
  taskId,
  completed: true,
}), bareUrl, "cookie fallback remains only after safer posters are absent");

assert.equal(coverFor({
  posterUrl: bareUrl,
  taskId,
  completed: false,
}), "", "incomplete cards do not invent a thumbnail fallback");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gallery = readFileSync(resolve(root, "src/components/video-history-gallery.tsx"), "utf8");
const workbench = readFileSync(resolve(root, "src/components/storyboard-workbench.tsx"), "utf8");
assert.match(gallery, /coverFor\(\{[\s\S]*posterUrl: task\.thumbnailUrl/);
assert.match(workbench, /coverFor\(\{[\s\S]*posterUrl: task\.thumbnailUrl/);
assert.doesNotMatch(gallery, /function safeImageUrl/);

console.log(JSON.stringify({
  passed: true,
  checks: [
    "ticketed-thumbnail-allowed",
    "bare-thumbnail-not-primary",
    "cover-prefers-ticket",
    "bare-cookie-fallback",
    "history-call-sites",
  ],
}, null, 2));
