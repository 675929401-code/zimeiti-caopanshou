#!/usr/bin/env node

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";

const MAX_HTML_BYTES = 524_288;
const MAX_ASSET_BYTES = 65_536;
const MAX_STATIC_ASSETS = 8;
const TIMEOUT_MS = 8_000;
const DEFAULT_LOGIN_PATH = "/admin/superzhujunguo";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function parseArgs(argv) {
  const valueArguments = new Set(["--config", "--target-key", "--fixture"]);
  const booleanArguments = new Set(["--send", "--dry-run", "--help", "--validate-config", "--self-test-addresses"]);
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`UNKNOWN_ARGUMENT:${token}`);
    if (booleanArguments.has(token)) {
      flags.add(token.slice(2));
      continue;
    }
    if (!valueArguments.has(token)) throw new Error(`UNKNOWN_ARGUMENT:${token}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`MISSING_ARGUMENT_VALUE:${token}`);
    const key = token.slice(2);
    values.set(key, [...(values.get(key) || []), next]);
    index += 1;
  }
  return {
    flag: (name) => flags.has(name),
    one: (name, fallback = null) => values.get(name)?.at(-1) ?? fallback,
    many: (name) => values.get(name) || [],
  };
}

function help() {
  return `外部站点监测独立探针\n\n默认不访问网络、不写入。探测目标和摄取端点只能来自部署主机上的配置白名单，命令行不能传任意 URL。\n\n只读探测示例：\n  node scripts/external-site-monitor-worker.mjs --config /etc/zimeiti/external-monitor.json --target-key primary --dry-run\n\n签名摄取示例：\n  EXTERNAL_SITE_MONITOR_INGEST_SECRET=... node scripts/external-site-monitor-worker.mjs --config /etc/zimeiti/external-monitor.json --target-key primary --send\n\n离线检查：\n  node scripts/external-site-monitor-worker.mjs --config scripts/fixtures/external-site-monitor-worker-config.json --validate-config\n  node scripts/external-site-monitor-worker.mjs --fixture scripts/fixtures/external-site-monitor-probe.json\n`;
}

function boundedConfigText(value, field, minimum = 1, maximum = 200) {
  if (typeof value !== "string") throw new Error(`INVALID_CONFIG_${field.toUpperCase()}`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\r\n]/u.test(normalized)) {
    throw new Error(`INVALID_CONFIG_${field.toUpperCase()}`);
  }
  return normalized;
}

function normalizeOrigin(value, field) {
  const url = new URL(boundedConfigText(value, field, 8, 300));
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.port) {
    throw new Error(`INVALID_CONFIG_${field.toUpperCase()}`);
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/u.test(url.hostname)) {
    throw new Error(`INVALID_CONFIG_${field.toUpperCase()}`);
  }
  return url.origin;
}

async function loadWorkerConfig(path) {
  if (!path) throw new Error("WORKER_CONFIG_REQUIRED");
  const raw = JSON.parse(await readFile(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1) throw new Error("WORKER_CONFIG_SCHEMA_INVALID");
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 20) throw new Error("WORKER_CONFIG_TARGETS_INVALID");
  const targets = raw.targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("WORKER_CONFIG_TARGET_INVALID");
    const loginMarkers = Array.isArray(target.loginMarkers) ? target.loginMarkers.slice(0, 8).map((marker) => ({
      label: boundedConfigText(marker?.label, "login_marker_label", 1, 80),
      literal: boundedConfigText(marker?.literal, "login_marker_literal", 1, 200),
    })) : [];
    return {
      key: boundedConfigText(target.key, "target_key", 2, 80),
      origin: normalizeOrigin(target.origin, "target_origin"),
      loginPath: normalizePath(target.loginPath || DEFAULT_LOGIN_PATH, "login_path"),
      staticPaths: Array.isArray(target.staticPaths)
        ? target.staticPaths.slice(0, MAX_STATIC_ASSETS).map((item) => normalizePath(item, "static_path"))
        : [],
      loginMarkers,
    };
  });
  if (new Set(targets.map((target) => target.key)).size !== targets.length) throw new Error("WORKER_CONFIG_TARGET_KEYS_DUPLICATED");
  const ingest = raw.ingest && typeof raw.ingest === "object" && !Array.isArray(raw.ingest)
    ? {
        endpoint: boundedConfigText(raw.ingest.endpoint, "ingest_endpoint", 12, 500),
        keyId: boundedConfigText(raw.ingest.keyId, "ingest_key_id", 3, 100),
      }
    : null;
  if (ingest) {
    const ingestUrl = new URL(ingest.endpoint);
    if (ingestUrl.protocol !== "https:" || ingestUrl.pathname !== "/api/internal/external-site-monitor/ingest" || ingestUrl.search || ingestUrl.hash) {
      throw new Error("WORKER_CONFIG_INGEST_ENDPOINT_INVALID");
    }
  }
  return {
    schemaVersion: 1,
    schedulerId: boundedConfigText(raw.schedulerId, "scheduler_id", 3, 100),
    vantage: {
      id: boundedConfigText(raw.vantage?.id, "vantage_id", 3, 100),
      region: boundedConfigText(raw.vantage?.region, "vantage_region", 2, 100),
      provider: raw.vantage?.provider == null ? null : boundedConfigText(raw.vantage.provider, "vantage_provider", 1, 100),
    },
    targets,
    ingest,
  };
}

function errorCode(error, fallback) {
  const messageCode = String(error?.message || "").split(":", 1)[0];
  const source = String(error?.code || (/^[A-Z][A-Z0-9_]{2,99}$/u.test(messageCode) ? messageCode : null) || error?.name || fallback || "PROBE_FAILED")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return /^[A-Z][A-Z0-9_]{2,99}$/u.test(source) ? source : fallback;
}

function durationMs(started) {
  return Math.round((Number(process.hrtime.bigint() - started) / 1_000_000) * 100) / 100;
}

function ipv4ToBigInt(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function ipv4InCidr(address, network, prefixLength) {
  const value = ipv4ToBigInt(address);
  const base = ipv4ToBigInt(network);
  if (value === null || base === null) return false;
  const shift = 32n - BigInt(prefixLength);
  return (value >> shift) === (base >> shift);
}

function ipv6ToBigInt(address) {
  if (isIP(address) !== 6) return null;
  let normalized;
  try {
    normalized = new URL(`http://[${address.split("%", 1)[0]}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8 || parts.some((part) => !/^[a-f0-9]{1,4}$/u.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6InCidr(address, network, prefixLength) {
  const value = ipv6ToBigInt(address);
  const base = ipv6ToBigInt(network);
  if (value === null || base === null) return false;
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (base >> shift);
}

const DENIED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPublicIpv4(address) {
  return isIP(address) === 4
    && !DENIED_IPV4_CIDRS.some(([network, prefixLength]) => ipv4InCidr(address, network, prefixLength));
}

function isPublicIpv6(address) {
  if (isIP(address) !== 6 || !ipv6InCidr(address, "2000::", 3)) return false;
  return !(
    ipv6InCidr(address, "2001::", 23)
    || ipv6InCidr(address, "2001:db8::", 32)
    || ipv6InCidr(address, "2002::", 16)
    || ipv6InCidr(address, "3fff::", 20)
  );
}

function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

async function resolvePublicTarget(hostname, counters) {
  const started = process.hrtime.bigint();
  counters.networkCalls += 2;
  const [ipv4Result, ipv6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  const ipv4 = ipv4Result.status === "fulfilled" ? [...new Set(ipv4Result.value)].filter(isPublicAddress) : [];
  const ipv6 = ipv6Result.status === "fulfilled" ? [...new Set(ipv6Result.value)].filter(isPublicAddress) : [];
  const all = [...ipv4, ...ipv6].sort();
  if (all.length === 0) {
    const error = new Error("DNS_PUBLIC_ADDRESS_REQUIRED");
    error.code = "DNS_PUBLIC_ADDRESS_REQUIRED";
    throw Object.assign(error, { durationMs: durationMs(started), ipv4Count: 0, ipv6Count: 0 });
  }
  return {
    check: {
      state: "passed",
      durationMs: durationMs(started),
      ipv4Count: ipv4.length,
      ipv6Count: ipv6.length,
      answerSetSha256: sha256(all.join("\n")),
      errorCode: null,
    },
    pinned: { address: all[0], family: isIP(all[0]) },
  };
}

function failedDns(error) {
  return {
    state: "failed",
    durationMs: Number.isFinite(error?.durationMs) ? error.durationMs : null,
    ipv4Count: Number.isInteger(error?.ipv4Count) ? error.ipv4Count : null,
    ipv6Count: Number.isInteger(error?.ipv6Count) ? error.ipv6Count : null,
    answerSetSha256: null,
    errorCode: errorCode(error, "DNS_PROBE_FAILED"),
  };
}

async function probeTls(hostname, pinned, counters) {
  const started = process.hrtime.bigint();
  counters.networkCalls += 1;
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: pinned.address,
      family: pinned.family,
      port: 443,
      servername: hostname,
      rejectUnauthorized: true,
      timeout: TIMEOUT_MS,
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("secureConnect", () => {
      try {
        const certificate = socket.getPeerCertificate(true);
        const fingerprint = String(certificate.fingerprint256 || "").replace(/:/gu, "").toLowerCase();
        const validFrom = new Date(certificate.valid_from);
        const validTo = new Date(certificate.valid_to);
        const now = Date.now();
        finish({
          state: "passed",
          durationMs: durationMs(started),
          negotiatedProtocol: socket.getProtocol() || null,
          certificateFingerprintSha256: /^[a-f0-9]{64}$/u.test(fingerprint) ? fingerprint : null,
          sanSetSha256: certificate.subjectaltname ? sha256(String(certificate.subjectaltname).split(",").map((item) => item.trim()).sort().join("\n")) : null,
          certificateNotBefore: Number.isFinite(validFrom.getTime()) ? validFrom.toISOString() : null,
          certificateNotAfter: Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
          daysRemaining: Number.isFinite(validTo.getTime()) ? Math.round(((validTo.getTime() - now) / 86_400_000) * 100) / 100 : null,
          errorCode: null,
        });
      } catch (error) {
        finish(failedTls(error, started));
      }
    });
    socket.once("timeout", () => finish(failedTls(Object.assign(new Error("TLS_TIMEOUT"), { code: "TLS_TIMEOUT" }), started)));
    socket.once("error", (error) => finish(failedTls(error, started)));
  });
}

function failedTls(error, started = null) {
  return {
    state: "failed",
    durationMs: started ? durationMs(started) : null,
    negotiatedProtocol: null,
    certificateFingerprintSha256: null,
    sanSetSha256: null,
    certificateNotBefore: null,
    certificateNotAfter: null,
    daysRemaining: null,
    errorCode: errorCode(error, "TLS_PROBE_FAILED"),
  };
}

async function pinnedHttpsGet(url, pinned, counters, maximumBytes, redirects = 0) {
  const parsed = new URL(url);
  const started = process.hrtime.bigint();
  counters.networkCalls += 1;
  return new Promise((resolve, reject) => {
    const request = https.request(parsed, {
      method: "GET",
      servername: parsed.hostname,
      rejectUnauthorized: true,
      headers: {
        "User-Agent": "Zimeiti-External-Site-Monitor/1.0",
        Accept: "text/html,application/xhtml+xml,text/css,application/javascript,*/*;q=0.5",
        "Accept-Encoding": "identity",
        Range: `bytes=0-${maximumBytes - 1}`,
      },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, (response) => {
      const statusCode = response.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(Object.assign(new Error("HTTPS_REDIRECT_LIMIT"), { code: "HTTPS_REDIRECT_LIMIT" }));
        const redirected = new URL(response.headers.location, parsed);
        if (redirected.protocol !== "https:" || redirected.hostname !== parsed.hostname || redirected.port) {
          return reject(Object.assign(new Error("HTTPS_REDIRECT_OUTSIDE_TARGET"), { code: "HTTPS_REDIRECT_OUTSIDE_TARGET" }));
        }
        return resolve(pinnedHttpsGet(redirected.href, pinned, counters, maximumBytes, redirects + 1));
      }
      const chunks = [];
      let sampled = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode,
          durationMs: durationMs(started),
          finalUrl: parsed.href,
          contentType: String(response.headers["content-type"] || "").slice(0, 120) || null,
          bytesSampled: sampled,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      };
      response.on("data", (chunk) => {
        if (settled || sampled >= maximumBytes) return;
        const buffer = Buffer.from(chunk);
        const accepted = buffer.subarray(0, Math.max(0, maximumBytes - sampled));
        if (accepted.length) chunks.push(accepted);
        sampled += accepted.length;
        if (sampled >= maximumBytes) {
          finish();
          response.destroy();
        }
      });
      response.once("end", finish);
      response.once("error", (error) => { if (!settled) reject(error); });
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(Object.assign(new Error("HTTPS_TIMEOUT"), { code: "HTTPS_TIMEOUT" })));
    request.once("error", reject);
    request.end();
  });
}

function failedHttps(error, started = null) {
  return {
    state: "failed",
    durationMs: started ? durationMs(started) : null,
    statusCode: null,
    finalUrlSha256: null,
    contentType: null,
    bytesSampled: null,
    errorCode: errorCode(error, "HTTPS_PROBE_FAILED"),
  };
}

function discoverStaticPaths(html, origin) {
  const paths = [];
  const patterns = [
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu,
    /<link\b[^>]*\brel=["'][^"']*(?:stylesheet|icon|preload)[^"']*["'][^>]*\bhref=["']([^"']+)["'][^>]*>/giu,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*(?:stylesheet|icon|preload)[^"']*["'][^>]*>/giu,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      try {
        const url = new URL(match[1], origin);
        if (url.origin !== origin) continue;
        const requestPath = `${url.pathname}${url.search}`;
        const evidencePath = url.search ? `${url.pathname}?query-sha256=${sha256(url.search)}` : url.pathname;
        if (requestPath.startsWith("/") && !paths.some((item) => item.requestPath === requestPath)) {
          paths.push({ requestPath, evidencePath });
        }
      } catch {
        // Ignore malformed HTML attributes; the source document hash still
        // preserves evidence that a different document was inspected.
      }
    }
  }
  return paths.slice(0, MAX_STATIC_ASSETS);
}

async function probeStaticAssets(paths, origin, pinned, counters) {
  const items = [];
  for (const item of paths.slice(0, MAX_STATIC_ASSETS)) {
    const requestPath = typeof item === "string" ? item : item.requestPath;
    const evidencePath = typeof item === "string" ? item : item.evidencePath;
    try {
      const result = await pinnedHttpsGet(new URL(requestPath, origin).href, pinned, counters, MAX_ASSET_BYTES);
      const passed = result.statusCode >= 200 && result.statusCode < 400;
      items.push({
        path: evidencePath,
        state: passed ? "passed" : "failed",
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        contentType: result.contentType,
        errorCode: passed ? null : "STATIC_ASSET_HTTP_FAILURE",
      });
    } catch (error) {
      items.push({ path: evidencePath, state: "failed", statusCode: null, durationMs: null, contentType: null, errorCode: errorCode(error, "STATIC_ASSET_FAILED") });
    }
  }
  if (paths.length === 0) {
    return { state: "unavailable", discoveredCount: 0, checkedCount: 0, items, errorCode: "STATIC_ASSET_NOT_DISCOVERED" };
  }
  return {
    state: items.every((item) => item.state === "passed") ? "passed" : "failed",
    discoveredCount: paths.length,
    checkedCount: items.length,
    items,
    errorCode: items.every((item) => item.state === "passed") ? null : "STATIC_ASSET_CHECK_FAILED",
  };
}

function markerConfiguration(configured) {
  return configured.length > 0 ? configured : [
    { label: "登录标题", literal: "登录管理后台" },
    { label: "密码输入框", literal: "type=\"password\"" },
    { label: "提交按钮", literal: "登录" },
  ];
}

async function probeLoginDom(origin, loginPath, markers, pinned, counters) {
  try {
    const result = await pinnedHttpsGet(new URL(loginPath, origin).href, pinned, counters, MAX_HTML_BYTES);
    const observations = markers.map((marker) => ({ label: marker.label, present: result.body.includes(marker.literal) }));
    const passed = result.statusCode >= 200 && result.statusCode < 400 && observations.every((marker) => marker.present);
    return {
      state: passed ? "passed" : "failed",
      probeMode: "server_html_dom",
      durationMs: result.durationMs,
      statusCode: result.statusCode,
      documentSha256: sha256(result.body),
      markers: observations,
      errorCode: passed ? null : "LOGIN_DOM_MARKER_MISSING",
    };
  } catch (error) {
    return {
      state: "failed",
      probeMode: "server_html_dom",
      durationMs: null,
      statusCode: null,
      documentSha256: null,
      markers: markers.map((marker) => ({ label: marker.label, present: false })),
      errorCode: errorCode(error, "LOGIN_DOM_PROBE_FAILED"),
    };
  }
}

function normalizePath(path, field) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\r\n\\?#]/u.test(path) || path.length > 300) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }
  return path;
}

async function runProbe(config, target) {
  const originUrl = new URL(target.origin);
  const schedulerId = config.schedulerId;
  const vantageId = config.vantage.id;
  const region = config.vantage.region;
  const loginPath = target.loginPath;
  const configuredStaticPaths = target.staticPaths;
  const markers = markerConfiguration(target.loginMarkers);
  const counters = { networkCalls: 0 };
  const startedAt = new Date().toISOString();

  let dnsResult;
  try {
    dnsResult = await resolvePublicTarget(originUrl.hostname, counters);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: 1,
      monitorKind: "external_site_monitor",
      probeRunId: randomUUID(),
      schedulerId,
      vantage: { kind: "external", id: vantageId, region, provider: config.vantage.provider },
      target: { hostname: originUrl.hostname, origin: originUrl.origin, loginPath },
      startedAt,
      completedAt,
      overallStatus: "failed",
      checks: {
        dns: failedDns(error),
        tls: { ...failedTls(null), state: "unavailable", errorCode: "DNS_GATE_FAILED" },
        https: { ...failedHttps(null), state: "unavailable", errorCode: "DNS_GATE_FAILED" },
        staticAssets: { state: "unavailable", discoveredCount: null, checkedCount: null, items: [], errorCode: "DNS_GATE_FAILED" },
        loginDom: { state: "unavailable", probeMode: "server_html_dom", durationMs: null, statusCode: null, documentSha256: null, markers: markers.map((marker) => ({ label: marker.label, present: false })), errorCode: "DNS_GATE_FAILED" },
      },
      privacy: { rawResolvedAddressesIncluded: false, responseBodyIncluded: false, credentialsIncluded: false },
    };
    return { payload: { ...evidence, evidenceSha256: sha256(stableJson(evidence)) }, counters };
  }

  const tlsCheck = await probeTls(originUrl.hostname, dnsResult.pinned, counters);
  let httpsCheck;
  let homepageHtml = "";
  if (tlsCheck.state === "passed") {
    try {
      const result = await pinnedHttpsGet(originUrl.href, dnsResult.pinned, counters, MAX_HTML_BYTES);
      const passed = result.statusCode >= 200 && result.statusCode < 400;
      homepageHtml = result.body;
      httpsCheck = {
        state: passed ? "passed" : "failed",
        durationMs: result.durationMs,
        statusCode: result.statusCode,
        finalUrlSha256: sha256(result.finalUrl),
        contentType: result.contentType,
        bytesSampled: result.bytesSampled,
        errorCode: passed ? null : "HTTPS_STATUS_FAILED",
      };
    } catch (error) {
      httpsCheck = failedHttps(error);
    }
  } else {
    httpsCheck = { ...failedHttps(null), state: "unavailable", errorCode: "TLS_GATE_FAILED" };
  }

  const discovered = configuredStaticPaths.length > 0 ? configuredStaticPaths : discoverStaticPaths(homepageHtml, originUrl.origin);
  const staticAssets = httpsCheck.state === "passed"
    ? await probeStaticAssets(discovered, originUrl.origin, dnsResult.pinned, counters)
    : { state: "unavailable", discoveredCount: null, checkedCount: null, items: [], errorCode: "HTTPS_GATE_FAILED" };
  const loginDom = tlsCheck.state === "passed"
    ? await probeLoginDom(originUrl.origin, loginPath, markers, dnsResult.pinned, counters)
    : { state: "unavailable", probeMode: "server_html_dom", durationMs: null, statusCode: null, documentSha256: null, markers: markers.map((marker) => ({ label: marker.label, present: false })), errorCode: "TLS_GATE_FAILED" };
  const criticalFailed = tlsCheck.state === "failed" || httpsCheck.state === "failed";
  const secondaryFailed = staticAssets.state !== "passed" || loginDom.state !== "passed";
  const completedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    monitorKind: "external_site_monitor",
    probeRunId: randomUUID(),
    schedulerId,
    vantage: { kind: "external", id: vantageId, region, provider: config.vantage.provider },
    target: { hostname: originUrl.hostname, origin: originUrl.origin, loginPath },
    startedAt,
    completedAt,
    overallStatus: criticalFailed ? "failed" : secondaryFailed ? "degraded" : "passed",
    checks: { dns: dnsResult.check, tls: tlsCheck, https: httpsCheck, staticAssets, loginDom },
    privacy: { rawResolvedAddressesIncluded: false, responseBodyIncluded: false, credentialsIncluded: false },
  };
  return { payload: { ...evidence, evidenceSha256: sha256(stableJson(evidence)) }, counters };
}

async function sendPayload(payload, config, args) {
  if (!args.flag("send")) return { attempted: false, durable: false, reason: "dry_run_default" };
  const endpoint = config?.ingest?.endpoint;
  const secret = process.env.EXTERNAL_SITE_MONITOR_INGEST_SECRET?.trim();
  const keyId = config?.ingest?.keyId;
  if (!endpoint || !secret || !keyId) throw new Error("INGEST_ENDPOINT_SECRET_AND_KEY_ID_REQUIRED");
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("HTTPS_INGEST_ENDPOINT_REQUIRED");
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(24).toString("base64url");
  const bodyHash = sha256(rawBody);
  const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${bodyHash}`).digest("hex")}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-External-Probe-Timestamp": timestamp,
      "X-External-Probe-Nonce": nonce,
      "X-External-Probe-Signature": signature,
      "X-External-Probe-Key-Id": keyId,
    },
    body: rawBody,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const receipt = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`INGEST_FAILED_${response.status}:${JSON.stringify(receipt)}`);
  return { attempted: true, durable: receipt?.durable === true, status: response.status, receipt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flag("help")) {
    process.stdout.write(help());
    return;
  }
  if (args.flag("self-test-addresses")) {
    const blocked = [
      "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "192.0.2.1",
      "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::1",
      "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1",
      "2002:7f00:1::", "3fff::1",
    ];
    const allowed = ["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"];
    const rejected = blocked.filter((address) => isPublicAddress(address));
    const denied = allowed.filter((address) => !isPublicAddress(address));
    if (rejected.length || denied.length) throw new Error(`ADDRESS_CLASSIFICATION_FAILED:${[...rejected, ...denied].join(",")}`);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "address_classification_self_test",
      externalNetworkCalls: 0,
      ingest: { attempted: false, durable: false },
      blockedCases: blocked.length,
      allowedCases: allowed.length,
    }, null, 2)}\n`);
    return;
  }
  if (args.flag("send") && args.flag("dry-run")) throw new Error("SEND_AND_DRY_RUN_ARE_MUTUALLY_EXCLUSIVE");
  const fixturePath = args.one("fixture");
  const configPath = args.one("config");
  if (fixturePath && args.flag("send")) throw new Error("FIXTURE_INGEST_FORBIDDEN");
  if (!fixturePath && !configPath) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "dry_run_idle",
      externalNetworkCalls: 0,
      ingest: { attempted: false, durable: false },
      message: "未提供目标；没有访问网络，也没有写入。使用 --help 查看部署参数。",
    }, null, 2)}\n`);
    return;
  }

  const config = configPath ? await loadWorkerConfig(configPath) : null;
  if (args.flag("validate-config")) {
    if (!config) throw new Error("WORKER_CONFIG_REQUIRED");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "config_validation",
      externalNetworkCalls: 0,
      ingest: { attempted: false, durable: false },
      schedulerId: config.schedulerId,
      targetKeys: config.targets.map((target) => target.key),
      ingestConfigured: Boolean(config.ingest),
    }, null, 2)}\n`);
    return;
  }
  let payload;
  let externalNetworkCalls = 0;
  if (fixturePath) {
    payload = JSON.parse(await readFile(fixturePath, "utf8"));
  } else {
    if (!config) throw new Error("WORKER_CONFIG_REQUIRED");
    const targetKey = args.one("target-key");
    const target = targetKey
      ? config.targets.find((candidate) => candidate.key === targetKey)
      : config.targets.length === 1 ? config.targets[0] : null;
    if (!target) throw new Error("CONFIGURED_TARGET_KEY_REQUIRED");
    const run = await runProbe(config, target);
    payload = run.payload;
    externalNetworkCalls = run.counters.networkCalls;
  }
  const ingest = await sendPayload(payload, config, args);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: args.flag("send") ? "signed_ingest" : fixturePath ? "fixture_dry_run" : "external_probe_dry_run",
    externalNetworkCalls,
    ingest,
    payload,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: errorCode(error, "EXTERNAL_SITE_MONITOR_WORKER_FAILED"), error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});
