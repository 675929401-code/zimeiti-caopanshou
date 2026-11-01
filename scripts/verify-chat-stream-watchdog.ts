import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chatStreamWatchdogTimeout, createChatStreamWatchdog } from "../src/lib/chat-stream-watchdog";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";

class FakeClock {
  now = 0;
  nextId = 0;
  scheduled = new Map<number, { due: number; callback: () => void }>();
  callbacks = new Map<number, () => void>();
  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.scheduled.set(id, { due: this.now + milliseconds, callback });
    this.callbacks.set(id, callback);
    return id;
  };
  clearTimeout = (id: number): void => { this.scheduled.delete(id); };
  advanceTo(target: number): void {
    assert.ok(target >= this.now);
    while (true) {
      const next = [...this.scheduled.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].due;
      this.scheduled.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

const checks: string[] = [];
const check = (name: string, actual: unknown, expected: unknown = true) => {
  assert.deepEqual(actual, expected, name); checks.push(name);
};
function harness() {
  const clock = new FakeClock();
  const controllers = new Map<string, AbortController>();
  const streaming = new Set<string>();
  const expired: string[] = [];
  const watchdog = createChatStreamWatchdog({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onExpire: ({ conversationId, controller }) => {
      if (controllers.get(conversationId) !== controller) return false;
      expired.push(conversationId);
      streaming.delete(conversationId);
    } });
  const register = (id: string, controller = new AbortController(), agentId = "ordinary-agent") => {
    controllers.set(id, controller); streaming.add(id); watchdog.register(id, controller, agentId); return controller;
  };
  return { clock, watchdog, register, streaming, expired };
}

check("ordinary request is bounded at 300 seconds", chatStreamWatchdogTimeout("ordinary-agent"), 300000);
check("exact high-energy identity gets 2400 seconds", chatStreamWatchdogTimeout(STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID), 2400000);
check("exact movie director identity gets the same 2400 seconds", chatStreamWatchdogTimeout(STORY_DIRECTOR_MOVIE_AGENT_ID), 2400000);
check("model name cannot grant longer deadline", chatStreamWatchdogTimeout("gpt-6.1-sol"), 300000);
check("unresolved identity keeps ordinary deadline", chatStreamWatchdogTimeout(undefined), 300000);
check("movie identity suffix cannot grant longer deadline", chatStreamWatchdogTimeout(`${STORY_DIRECTOR_MOVIE_AGENT_ID}-alias`), 300000);
check("display name cannot grant longer deadline", chatStreamWatchdogTimeout("3D故事导演｜高能版"), 300000);
check("identity suffix cannot grant longer deadline", chatStreamWatchdogTimeout(`${STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID}-alias`), 300000);
const ordinary = harness();
const ordinaryController = ordinary.register("ordinary");
ordinary.clock.advanceTo(299999);
check("ordinary still active before its deadline", ordinaryController.signal.aborted, false);
ordinary.clock.advanceTo(300000);
check("ordinary aborts at its own deadline", ordinaryController.signal.aborted);
check("ordinary expiry is scoped to its conversation", ordinary.expired, ["ordinary"]);
check("expired registration is removed", ordinary.watchdog.size(), 0);

const long = harness();
const longController = long.register("long", new AbortController(), STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID);
long.clock.advanceTo(300000);
check("high-energy survives the former global 300s cutoff", longController.signal.aborted, false);
long.clock.advanceTo(900000);
check("full-article high-energy survives the former 900s cutoff", longController.signal.aborted, false);
long.clock.advanceTo(2399999);
check("high-energy remains bounded but active before 2400s", longController.signal.aborted, false);
long.clock.advanceTo(2400000);
check("high-energy aborts at 2400s", longController.signal.aborted);
check("high-energy expiry fires once", long.expired, ["long"]);

const movie = harness();
const movieController = movie.register("movie", new AbortController(), STORY_DIRECTOR_MOVIE_AGENT_ID);
movie.clock.advanceTo(300000);
check("movie survives the former 300s cutoff", movieController.signal.aborted, false);
movie.clock.advanceTo(900000);
check("full-article movie survives the former 900s cutoff", movieController.signal.aborted, false);
movie.clock.advanceTo(2399999);
check("movie remains active immediately before 2400s", movieController.signal.aborted, false);
movie.watchdog.register("movie", movieController, STORY_DIRECTOR_MOVIE_AGENT_ID);
movie.clock.advanceTo(2400000);
check("movie expires at original 2400s despite repeated registration", movieController.signal.aborted);
check("movie expiry fires once and cleans registration", movie.expired, ["movie"]);
check("movie expiry cleans its timer", movie.watchdog.size(), 0);

const concurrent = harness();
const shortController = concurrent.register("short");
const concurrentLong = concurrent.register("high", new AbortController(), STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID);
concurrent.clock.advanceTo(300000);
check("ordinary concurrent request expires", shortController.signal.aborted);
check("ordinary expiry does not abort high-energy controller", concurrentLong.signal.aborted, false);
check("ordinary expiry does not clear other streaming state", [...concurrent.streaming], ["high"]);
check("other request still owns an active timer", concurrent.watchdog.size(), 1);
concurrent.clock.advanceTo(2400000);
check("concurrent high-energy later expires independently", concurrent.expired, ["short", "high"]);

const replacement = harness();
const oldController = replacement.register("same");
replacement.clock.advanceTo(200000);
const newController = replacement.register("same");
replacement.watchdog.clear("same", oldController);
check("old finalizer cannot clear replacement timer", replacement.watchdog.size(), 1);
replacement.clock.callbacks.get(0)?.();
check("queued stale callback cannot abort replacement", newController.signal.aborted, false);
replacement.clock.advanceTo(300000);
check("new controller does not inherit old deadline", newController.signal.aborted, false);
replacement.clock.advanceTo(499999);
check("replacement uses its own registration start", newController.signal.aborted, false);
replacement.clock.advanceTo(500000);
check("replacement expires after its fresh 300s budget", newController.signal.aborted);
check("replacement generates only one current expiry", replacement.expired, ["same"]);

const repeated = harness();
const sameController = repeated.register("same-controller");
repeated.clock.advanceTo(200000);
repeated.watchdog.register("same-controller", sameController, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID);
repeated.clock.advanceTo(300000);
check("re-registering same controller never resets timer or agent budget", sameController.signal.aborted);

const finished = harness();
const finishedController = finished.register("finished");
finished.watchdog.clear("finished", finishedController);
check("completion removes even timer handle zero", finished.clock.scheduled.size, 0);
finished.clock.advanceTo(2400000);
check("finished controller cannot be aborted later", finishedController.signal.aborted, false);
check("finished registration leaves no expiry", finished.expired.length, 0);

const manuallyStopped = harness();
const manualController = manuallyStopped.register("manual");
manualController.abort();
check("manual abort immediately removes watchdog", manuallyStopped.watchdog.size(), 0);
check("manual abort clears scheduled timer", manuallyStopped.clock.scheduled.size, 0);
manuallyStopped.clock.advanceTo(2400000);
check("manual abort is never relabeled watchdog expiry", manuallyStopped.expired.length, 0);

const unmounted = harness();
unmounted.register("one"); unmounted.register("two", new AbortController(), STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID);
unmounted.watchdog.clearAll();
check("unmount cleanup removes all registrations", unmounted.watchdog.size(), 0);
check("unmount cleanup removes all timers", unmounted.clock.scheduled.size, 0);

const source = readFileSync(path.join(process.cwd(), "src/contexts/app-context.tsx"), "utf8");
check("all three stream paths register their actual agent", (source.match(/getOrCreateAbortController\(convId, agent\.id\)/gu) || []).length, 3);
check("old all-controller timeout is removed", !source.includes("isStreaming stuck for 300s"));
check("registration is independent of global streaming effect", source.includes("streamWatchdogRef.current?.register(convId, ctrl, agentId)"));
check("request finalizer clears only its controller registration", source.includes("streamWatchdogRef.current?.clear(convId, controller)"));
check("idle stream guard remains unchanged", source.includes("const SSE_READ_TIMEOUT = 310_000"));
console.log(JSON.stringify({ status: "passed", assertions: checks.length, fakeClock: true, networkCalls: 0, providerCalls: 0, checks }, null, 2));
