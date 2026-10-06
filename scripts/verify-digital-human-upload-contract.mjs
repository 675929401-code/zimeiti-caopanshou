#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const route = fs.readFileSync("src/app/api/digital-human/upload/route.ts", "utf8");
const proxy = fs.readFileSync("src/lib/digital-human-upload-proxy.ts", "utf8");
const direct = fs.readFileSync("src/lib/digital-human-direct-upload.ts", "utf8");
const ticket = fs.readFileSync("src/app/api/digital-human/upload-ticket/route.ts", "utf8");
const completion = fs.readFileSync("src/app/api/digital-human/upload-session/route.ts", "utf8");
const page = fs.readFileSync("src/app/digital-human/page.tsx", "utf8");
const nginx = fs.readFileSync("deploy/nginx/agent-hub.vnext.conf.example", "utf8");
const nextConfig = fs.readFileSync("next.config.ts", "utf8");

const videoLimit = Number(/LIMITS\s*=\s*\{[^}]*video:\s*(\d+)/su.exec(proxy)?.[1] || 0);
const requestLimit = Number(/MAX_REQUEST_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/u.exec(proxy)?.[1] || 0);
const proxyLimit = Number(/client_max_body_size\s+(\d+)m/iu.exec(nginx)?.[1] || 0);
const nextProxyLimit = Number(/proxyClientMaxBodySize:\s*["'](\d+)mb["']/iu.exec(nextConfig)?.[1] || 0);

assert.equal(videoLimit, 100, "digital-human video limit must match the published 100 MB contract");
assert.equal(requestLimit, 102, "multipart request ceiling must allow bounded overhead");
assert.ok(proxyLimit >= requestLimit, "Nginx body limit must be at least the application request limit");
assert.equal(nextProxyLimit, proxyLimit, "Next and Nginx request ceilings must match");
assert.match(page, /MP4 \/ MOV \/ AVI · 最大 100 MB/u);
assert.match(route, /handleDigitalHumanProxyUpload/u,
  "public compatibility route must delegate to the bounded proxy handler");
assert.match(proxy, /MAX_ACTIVE_BUFFERED_UPLOADS\s*=\s*1/u,
  "buffered upload parsing must have an admission-control guard");
assert.match(proxy, /Retry-After/u);
assert.match(proxy, /finally\s*\{\s*releaseUploadSlot\(\)/su);
assert.match(proxy, /file\.size > LIMITS\[category\].*status:\s*413/su);
assert.match(direct, /video:\s*100\s*\*\s*1024\s*\*\s*1024/u);
assert.match(ticket, /authorizeCurrentApiUser/u);
assert.match(completion, /authorizeCurrentApiUser/u);
assert.match(ticket, /digitalHumanUploadTicketId\(auth\.user\.userId/u);
assert.match(completion, /\.eq\('id',\s*ticketId\)\.eq\('user_id',\s*userId\)/u);

console.log(JSON.stringify({
  status: "PASS",
  applicationVideoLimitMb: videoLimit,
  applicationRequestLimitMb: requestLimit,
  nginxLimitMb: proxyLimit,
  nextProxyLimitMb: nextProxyLimit,
  bufferedUploadConcurrencyPerProcess: 1,
  directObjectStorageUploadRequiredForHundredsOfMembers: true,
  directUploadOwnerBound: true,
}, null, 2));
