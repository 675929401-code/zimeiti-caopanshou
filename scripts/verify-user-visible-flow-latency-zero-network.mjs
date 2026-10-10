#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(SCRIPT_DIR, "fixtures", "user-visible-flow-latency-baseline.v1.json");
const EVIDENCE_SCHEMA_PATH = path.join(SCRIPT_DIR, "contracts", "user-visible-flow-evidence.v1.schema.json");
const EXPECTED_BASELINE_SHA256 = "733dd0b3de3d84ef68f85e63a9955e245db64d306d509b57b56e4d1169e11905";
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const positive = (value, label, minimum) => {
  assert.ok(Number.isFinite(value), `${label}:NOT_FINITE`);
  assert.ok(value >= minimum, `${label}:ZERO_OR_BELOW_CLOCK_PRECISION:${value}`);
};

function nearestRank(values, percentile) {
  assert.ok(values.length > 0, "PERCENTILE_REQUIRES_VALUES");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function parseArgs(argv) {
  const options = { browsers: ["chromium", "edge", "firefox"], pretty: true };
  for (const argument of argv) {
    if (argument === "--compact") options.pretty = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--browsers=")) {
      options.browsers = argument.slice(argument.indexOf("=") + 1).split(",").map((value) => value.trim()).filter(Boolean);
    } else {
      throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  const allowed = new Set(["chromium", "edge", "firefox"]);
  assert.ok(options.browsers.length > 0, "AT_LEAST_ONE_LOCAL_BROWSER_REQUIRED");
  for (const browser of options.browsers) assert.ok(allowed.has(browser), `UNSUPPORTED_LOCAL_BROWSER:${browser}`);
  options.browsers = [...new Set(options.browsers)];
  return options;
}

function usage() {
  return [
    "Usage: node scripts/verify-user-visible-flow-latency-zero-network.mjs [options]",
    "",
    "Options:",
    "  --browsers=chromium,edge,firefox  run a subset for diagnosis; the full local pass still requires all three",
    "  --compact                           emit compact JSON",
    "  --help                              show this help",
    "",
    "This verifier uses an inline 1440x900 browser fixture and denies every browser network request.",
    "It proves only fixture/schema contracts, never the product runtime or a real provider.",
  ].join("\n");
}

function metricComparison(flow, metric, observed, contract) {
  positive(observed, `${flow}.${metric}`, 0.1);
  assert.equal(
    contract.maximumMs,
    contract.referenceMs + contract.allowedAbsoluteToleranceMs,
    `${flow}.${metric}:BASELINE_TOLERANCE_ARITHMETIC_MISMATCH`,
  );
  return {
    flow,
    metric,
    observedMs: round(observed),
    referenceMs: contract.referenceMs,
    allowedAbsoluteToleranceMs: contract.allowedAbsoluteToleranceMs,
    maximumMs: contract.maximumMs,
    passed: observed <= contract.maximumMs,
  };
}

function assertMetricComparisons(comparisons, browserId) {
  const failed = comparisons.filter((entry) => !entry.passed);
  assert.deepEqual(failed, [], `${browserId}:METRIC_TOLERANCE_FAILED:${JSON.stringify(failed)}`);
}

function validateEvidenceShape(evidence) {
  assert.equal(evidence.schemaVersion, "user-visible-flow-evidence.v1");
  assert.equal(evidence.evidenceLevel, "schema_verified");
  assert.equal(evidence.fixtureOnly, true);
  assert.equal(evidence.baseline.immutable, true);
  assert.equal(evidence.baseline.sha256, evidence.baseline.expectedSha256);
  assert.equal(evidence.networkBoundary.policy, "deny_all");
  for (const key of ["browserRequestsObserved", "realProviderCalls", "productRuntimeCalls", "writes", "paidCalls"]) {
    assert.equal(evidence.networkBoundary[key], 0, `NETWORK_BOUNDARY_VIOLATION:${key}`);
  }
  assert.equal(evidence.browserMatrix.length, 4, "BROWSER_MATRIX_MUST_NAME_FOUR_TARGETS");
  assert.deepEqual(evidence.browserMatrix.map((entry) => entry.id), ["chromium", "edge", "firefox", "safari"]);
  assert.equal(evidence.browserMatrix.at(-1).status, "external_evidence_required");
  assert.equal(evidence.summary.safariExternalEvidenceRequired, true);
}

const FIXTURE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 100vw; min-height: 100vh; background: #08111f; color: #eef7ff; font: 16px/1.6 system-ui, sans-serif; }
    main { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; width: 1180px; margin: 60px auto; }
    section { min-height: 360px; padding: 24px; border: 1px solid #2f4f68; border-radius: 18px; background: #102337; }
    button { min-height: 44px; padding: 0 20px; color: #062033; background: #72e0c5; border: 0; border-radius: 12px; font: inherit; font-weight: 700; }
    [role=status] { min-height: 32px; margin: 16px 0; color: #9be9d5; }
    #chat-output { min-height: 150px; padding: 16px; border-radius: 12px; background: #071827; white-space: pre-wrap; }
    #video-history { margin-top: 18px; padding: 14px; border-radius: 12px; background: #071827; }
  </style>
</head>
<body>
  <main>
    <section aria-labelledby="chat-heading">
      <h1 id="chat-heading">聊天流式回归夹具</h1>
      <button id="chat-submit" type="button">发送消息</button>
      <div id="chat-ack" role="status"></div>
      <div id="chat-output" aria-live="polite"></div>
    </section>
    <section aria-labelledby="video-heading">
      <h1 id="video-heading">视频任务回归夹具</h1>
      <button id="video-submit" type="button">提交视频</button>
      <div id="video-status" role="status"></div>
      <div id="video-history" data-state="idle">历史：尚未提交</div>
    </section>
  </main>
  <script>
    (() => {
      const baseline = window.__baseline;
      const finalText = "首段回答稳定增长，次段内容继续保持单调流式呈现。";
      const chunks = Array.from(finalText).reduce((all, character, index) => {
        if (index % baseline.flows.chat.fixture.chunkSizeCharacters === 0) all.push("");
        all[all.length - 1] += character;
        return all;
      }, []);
      const state = {
        chat: { requestAt: null, ackAt: null, provider: [], visible: [], finalText },
        video: { requestAt: null, ackAt: null, provider: [], ui: [], history: [] },
      };
      window.__fixtureState = state;
      // Firefox deliberately coarsens performance.now() in some contexts. Move
      // acknowledgement to the next timer tick before the paint callback so a
      // truly sub-clock-resolution result is not reported as an exact 0 ms.
      const queueVisibleAcknowledgement = (callback) => {
        setTimeout(() => requestAnimationFrame(callback), 1);
      };
      // A provider timestamp and a DOM mutation can land in the same
      // coarse Firefox performance.now() bucket even though the mutation was
      // queued with requestAnimationFrame. Requiring the following paint
      // frame preserves a real, measurable UI boundary without fabricating a
      // duration in the analyzer.
      const queueMeasuredPaint = (callback) => {
        requestAnimationFrame(() => requestAnimationFrame(callback));
      };

      const chatOutput = document.querySelector("#chat-output");
      new MutationObserver(() => {
        state.chat.visible.push({ text: chatOutput.textContent || "", at: performance.now() });
      }).observe(chatOutput, { childList: true, characterData: true, subtree: true });

      document.querySelector("#chat-submit").addEventListener("click", () => {
        state.chat.requestAt = performance.now();
        queueVisibleAcknowledgement(() => {
          document.querySelector("#chat-ack").textContent = "已发送，等待首段回复";
          state.chat.ackAt = performance.now();
        });
        chunks.forEach((chunk, index) => {
          const delay = baseline.flows.chat.fixture.simulatedProviderFirstChunkMs
            + index * baseline.flows.chat.fixture.simulatedProviderChunkCadenceMs;
          setTimeout(() => {
            const providerAt = performance.now();
            state.chat.provider.push({ index, chunk, at: providerAt });
            queueMeasuredPaint(() => chatOutput.append(document.createTextNode(chunk)));
          }, delay);
        });
      });

      const statusText = {
        accepted: "服务商已受理",
        processing: "服务商处理中",
        completed: "视频已完成，可在历史中查看",
      };
      const videoStatus = document.querySelector("#video-status");
      const videoHistory = document.querySelector("#video-history");
      document.querySelector("#video-submit").addEventListener("click", () => {
        state.video.requestAt = performance.now();
        queueVisibleAcknowledgement(() => {
          videoStatus.textContent = "已提交，正在等待服务商确认";
          state.video.ackAt = performance.now();
        });
        Object.entries(baseline.flows.video.fixture.providerScheduleMs).forEach(([providerState, delay]) => {
          setTimeout(() => {
            const providerAt = performance.now();
            state.video.provider.push({ state: providerState, at: providerAt });
            queueMeasuredPaint(() => {
              videoStatus.textContent = statusText[providerState];
              state.video.ui.push({ state: providerState, at: performance.now() });
              requestAnimationFrame(() => {
                videoHistory.dataset.state = providerState;
                videoHistory.textContent = "历史：" + statusText[providerState];
                state.video.history.push({ state: providerState, at: performance.now() });
                if (providerState === "completed") window.__runDone = true;
              });
            });
          }, delay);
        });
      });
    })();
  </script>
</body>
</html>`;

function analyzeBrowserResult(browserId, raw, baseline, browserRequestsObserved) {
  const minimumPositive = baseline.reportingPolicy.minimumPositiveDurationMs;
  assert.equal(browserRequestsObserved, 0, `${browserId}:BROWSER_NETWORK_REQUEST_OBSERVED`);
  assert.ok(raw.chat.requestAt != null && raw.chat.ackAt != null, `${browserId}:CHAT_ACK_MISSING`);
  assert.ok(raw.video.requestAt != null && raw.video.ackAt != null, `${browserId}:VIDEO_ACK_MISSING`);
  assert.equal(raw.chat.provider.length, raw.chat.visible.length, `${browserId}:CHAT_PROVIDER_VISIBLE_COUNT_MISMATCH`);
  assert.equal(raw.chat.visible.at(-1)?.text, raw.chat.finalText, `${browserId}:CHAT_FINAL_TEXT_MISMATCH`);

  const visibleStates = raw.chat.visible.map((entry) => entry.text);
  for (let index = 0; index < visibleStates.length; index += 1) {
    const current = visibleStates[index];
    const previous = index === 0 ? "" : visibleStates[index - 1];
    assert.ok(current.startsWith(previous), `${browserId}:CHAT_TEXT_RETRACTED:${index}`);
    assert.ok(raw.chat.finalText.startsWith(current), `${browserId}:CHAT_NON_PREFIX_STATE:${index}`);
    assert.ok(current.length >= previous.length, `${browserId}:CHAT_LENGTH_NOT_MONOTONIC:${index}`);
    assert.ok(
      Array.from(current.slice(previous.length)).length <= baseline.flows.chat.invariants.maximumCharactersPerMutation,
      `${browserId}:CHAT_CATCH_UP_BURST:${index}`,
    );
  }
  assert.ok(
    new Set(visibleStates).size >= baseline.flows.chat.invariants.minimumDistinctVisibleStates,
    `${browserId}:CHAT_TOO_FEW_INCREMENTAL_STATES`,
  );

  const chatUiAdded = raw.chat.visible.map((entry, index) => entry.at - raw.chat.provider[index].at);
  const chatMutationGaps = raw.chat.visible.slice(1).map((entry, index) => entry.at - raw.chat.visible[index].at);
  const chatMetrics = {
    uiAcknowledgementMs: raw.chat.ackAt - raw.chat.requestAt,
    simulatedProviderLatencyMs: raw.chat.provider[0].at - raw.chat.requestAt,
    requestToFirstVisibleTextMs: raw.chat.visible[0].at - raw.chat.requestAt,
    providerToFirstVisibleTextMs: chatUiAdded[0],
    providerToVisibleChunkP95Ms: nearestRank(chatUiAdded, 0.95),
    visibleMutationGapP95Ms: nearestRank(chatMutationGaps, 0.95),
    requestToFinalTextMs: raw.chat.visible.at(-1).at - raw.chat.requestAt,
    distinctVisibleStates: new Set(visibleStates).size,
    maximumCharactersPerMutation: Math.max(...visibleStates.map((value, index) => Array.from(value.slice(index ? visibleStates[index - 1].length : 0)).length)),
  };
  positive(chatMetrics.simulatedProviderLatencyMs, `${browserId}:chat.simulatedProviderLatencyMs`, minimumPositive);

  const expectedOrder = baseline.flows.video.invariants.providerStatusOrder;
  assert.deepEqual(raw.video.provider.map((entry) => entry.state), expectedOrder, `${browserId}:VIDEO_PROVIDER_ORDER_MISMATCH`);
  assert.deepEqual(raw.video.ui.map((entry) => entry.state), expectedOrder, `${browserId}:VIDEO_UI_ORDER_MISMATCH`);
  assert.deepEqual(raw.video.history.map((entry) => entry.state), expectedOrder, `${browserId}:VIDEO_HISTORY_ORDER_MISMATCH`);
  assert.ok(raw.video.ackAt < raw.video.provider[0].at, `${browserId}:VIDEO_ACK_NOT_IMMEDIATE`);
  const providerCompletedAt = raw.video.provider.find((entry) => entry.state === "completed").at;
  const uiCompletedAt = raw.video.ui.find((entry) => entry.state === "completed").at;
  const historyCompletedAt = raw.video.history.find((entry) => entry.state === "completed").at;
  assert.ok(uiCompletedAt >= providerCompletedAt, `${browserId}:VIDEO_UI_FALSE_EARLY_COMPLETION`);
  assert.ok(historyCompletedAt >= providerCompletedAt, `${browserId}:VIDEO_HISTORY_FALSE_EARLY_COMPLETION`);

  const videoUiAdded = raw.video.ui.map((entry, index) => entry.at - raw.video.provider[index].at);
  const videoHistoryAdded = raw.video.history.map((entry, index) => entry.at - raw.video.provider[index].at);
  const videoMetrics = {
    uiAcknowledgementMs: raw.video.ackAt - raw.video.requestAt,
    simulatedProviderAcceptanceMs: raw.video.provider[0].at - raw.video.requestAt,
    providerToUiStatusP95Ms: nearestRank(videoUiAdded, 0.95),
    providerToHistoryStatusP95Ms: nearestRank(videoHistoryAdded, 0.95),
    providerCompletedToHistoryCompletedMs: historyCompletedAt - providerCompletedAt,
  };
  positive(videoMetrics.simulatedProviderAcceptanceMs, `${browserId}:video.simulatedProviderAcceptanceMs`, minimumPositive);

  const comparisons = [
    ...Object.entries(baseline.flows.chat.metrics).map(([metric, contract]) => metricComparison("chat", metric, chatMetrics[metric], contract)),
    ...Object.entries(baseline.flows.video.metrics).map(([metric, contract]) => metricComparison("video", metric, videoMetrics[metric], contract)),
  ];
  assertMetricComparisons(comparisons, browserId);

  return {
    networkRequestsObserved: browserRequestsObserved,
    timingBoundary: {
      chat: {
        simulatedProviderLatencyMs: round(chatMetrics.simulatedProviderLatencyMs),
        uiAddedFirstVisibleTextMs: round(chatMetrics.providerToFirstVisibleTextMs),
      },
      video: {
        simulatedProviderAcceptanceMs: round(videoMetrics.simulatedProviderAcceptanceMs),
        uiAddedAcceptedStatusMs: round(videoUiAdded[0]),
        historyAddedAcceptedStatusMs: round(videoHistoryAdded[0]),
      },
      interpretation: "Simulated provider waiting is separated from browser UI-added latency; no value is claimed as 0ms.",
    },
    chat: Object.fromEntries(Object.entries(chatMetrics).map(([key, value]) => [key, round(value)])),
    video: Object.fromEntries(Object.entries(videoMetrics).map(([key, value]) => [key, round(value)])),
    comparisons,
    invariants: {
      chatMonotonic: true,
      chatFinalTextExact: true,
      videoProviderUiHistoryOrderMatched: true,
      noFalseEarlyCompletion: true,
    },
  };
}

async function findExistingEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next standard Windows installation path.
    }
  }
  return null;
}

async function findExistingExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next local installation path without downloading anything.
    }
  }
  return null;
}

async function browserDescriptor(id) {
  if (id === "chromium") return { id, engine: "chromium", execution: "local_headless", browserType: chromium, launchOptions: { headless: true } };
  if (id === "firefox") {
    const bundledExecutablePath = firefox.executablePath();
    const bundledExists = await findExistingExecutable([bundledExecutablePath]);
    return {
      id,
      engine: "firefox",
      execution: "local_headless",
      browserType: firefox,
      launchOptions: { headless: true, executablePath: bundledExists },
      unavailableReason: bundledExists ? null : "PLAYWRIGHT_FIREFOX_EXECUTABLE_NOT_INSTALLED_OFFLINE",
    };
  }
  if (id === "edge") {
    const executablePath = await findExistingEdge();
    return {
      id,
      engine: "chromium",
      execution: "local_headless_system_edge",
      browserType: chromium,
      launchOptions: { headless: true, executablePath },
      unavailableReason: executablePath ? null : "SYSTEM_EDGE_EXECUTABLE_NOT_FOUND",
    };
  }
  throw new Error(`UNKNOWN_BROWSER:${id}`);
}

async function runBrowser(descriptor, baseline) {
  if (descriptor.unavailableReason) {
    return { id: descriptor.id, engine: descriptor.engine, execution: descriptor.execution, status: "unavailable", result: null, error: descriptor.unavailableReason };
  }
  let browser;
  try {
    browser = await descriptor.browserType.launch(descriptor.launchOptions);
    const context = await browser.newContext({ viewport: baseline.scope.viewport, serviceWorkers: "block" });
    let browserRequestsObserved = 0;
    await context.route("**/*", async (route) => {
      browserRequestsObserved += 1;
      await route.abort("blockedbyclient");
    });
    await context.addInitScript((value) => { window.__baseline = value; }, baseline);
    const page = await context.newPage();
    await page.setContent(FIXTURE_HTML, { waitUntil: "domcontentloaded" });
    // Warm the compositor before starting the measured click. System Edge can
    // otherwise charge its very first headless paint startup to the product
    // acknowledgement even though that cost precedes the interaction.
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.click("#chat-submit");
    await page.click("#video-submit");
    await page.waitForFunction(() => window.__runDone === true, null, { timeout: 5_000 });
    await page.waitForFunction(() => window.__fixtureState.chat.visible.at(-1)?.text === window.__fixtureState.chat.finalText, null, { timeout: 5_000 });
    const raw = await page.evaluate(() => structuredClone(window.__fixtureState));
    const result = analyzeBrowserResult(descriptor.id, raw, baseline, browserRequestsObserved);
    await context.close();
    return { id: descriptor.id, engine: descriptor.engine, execution: descriptor.execution, status: "passed", result, error: null };
  } catch (error) {
    return {
      id: descriptor.id,
      engine: descriptor.engine,
      execution: descriptor.execution,
      status: "failed",
      result: null,
      error: error instanceof Error ? error.stack || error.message : String(error),
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const [baselineRaw, evidenceSchemaRaw] = await Promise.all([
    fs.readFile(BASELINE_PATH, "utf8"),
    fs.readFile(EVIDENCE_SCHEMA_PATH, "utf8"),
  ]);
  const baselineSha = sha256(baselineRaw);
  assert.equal(baselineSha, EXPECTED_BASELINE_SHA256, "IMMUTABLE_BASELINE_SHA256_MISMATCH");
  const baseline = JSON.parse(baselineRaw);
  const evidenceSchema = JSON.parse(evidenceSchemaRaw);
  assert.equal(baseline.schemaVersion, "user-visible-flow-latency-baseline.v1");
  assert.equal(evidenceSchema.$id, "user-visible-flow-evidence.v1.schema.json");
  assert.equal(baseline.reportingPolicy.zeroDurationClaimsAllowed, false);

  const localResults = [];
  for (const id of ["chromium", "edge", "firefox"]) {
    if (!options.browsers.includes(id)) {
      localResults.push({ id, engine: id === "firefox" ? "firefox" : "chromium", execution: "not_selected", status: "unavailable", result: null, error: "NOT_SELECTED_FOR_DIAGNOSTIC_RUN" });
      continue;
    }
    localResults.push(await runBrowser(await browserDescriptor(id), baseline));
  }
  const safari = baseline.browserMatrix.find((entry) => entry.id === "safari");
  const browserMatrix = [
    ...localResults,
    {
      id: "safari",
      engine: "webkit",
      execution: "external_real_safari",
      status: "external_evidence_required",
      result: { acceptedEvidence: safari.acceptedEvidence },
      error: null,
    },
  ];
  const requiredIds = baseline.browserMatrix.filter((entry) => entry.requiredForLocalPass).map((entry) => entry.id);
  const requiredResults = browserMatrix.filter((entry) => requiredIds.includes(entry.id));
  const localPassed = requiredResults.filter((entry) => entry.status === "passed").length;
  const localFailed = requiredResults.length - localPassed;
  const passed = localFailed === 0;
  const recordedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: "user-visible-flow-evidence.v1",
    runId: `uvf-${sha256(`${recordedAt}:${baselineSha}:${process.pid}`).slice(0, 20)}`,
    recordedAt,
    evidenceLevel: "schema_verified",
    fixtureOnly: true,
    baseline: {
      id: baseline.baselineId,
      sha256: baselineSha,
      expectedSha256: EXPECTED_BASELINE_SHA256,
      immutable: true,
      comparison: passed ? "within_tolerance" : "failed",
    },
    networkBoundary: {
      policy: "deny_all",
      browserRequestsObserved: browserMatrix.reduce((sum, entry) => sum + Number(entry.result?.networkRequestsObserved || 0), 0),
      realProviderCalls: 0,
      productRuntimeCalls: 0,
      writes: 0,
      paidCalls: 0,
    },
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      viewport: baseline.scope.viewport,
      clockPolicy: `performance.now; minimum reported positive duration ${baseline.reportingPolicy.minimumPositiveDurationMs}ms; zero-duration claims forbidden`,
    },
    browserMatrix,
    summary: {
      localRequired: requiredResults.length,
      localPassed,
      localFailed,
      safariExternalEvidenceRequired: true,
      passed,
    },
  };
  validateEvidenceShape(evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, options.pretty ? 2 : 0)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
