import "server-only";
import { formalCatalogPreviewEnabled } from "./formal-catalog-preview";
import { capture, createPublishedReader } from "./published-configuration-public.mjs";
import { createPublishedSnapshotStore, type PublishedSnapshot } from "./published-configuration-snapshot";

type Environment = Readonly<Record<string, string | undefined>>;
export type PublishedPreviewState = {
  schema: "published-configuration-preview.v1"; status: "online" | "offline";
  lastSuccessfulAt: string; lastAttemptAt: string; servedFrom: "live" | "disk";
  snapshot: PublishedSnapshot;
};
export class PublishedPreviewUnavailable extends Error {
  constructor(readonly cacheState: "missing" | "corrupt") { super("PUBLISHED_SOURCE_UNAVAILABLE"); }
}

export function publishedPreviewRequestAllowed(request: Request, env: Environment = process.env) {
  const url = new URL(request.url);
  const localOrigin = "http://127.0.0.1:5000";
  // NextRequest normalizes loopback URLs to localhost internally. Keep the
  // external authority pinned to the literal Host and Origin below.
  if (!formalCatalogPreviewEnabled(env) || request.method !== "GET"
    || ![localOrigin, "http://localhost:5000"].includes(url.origin)
    || request.headers.get("host") !== "127.0.0.1:5000" || url.pathname !== "/published-preview") return false;
  // A reverse proxy or cross-origin fetch must not turn this loopback route into
  // a server-side network bridge. No forwarding header influences its target.
  if (request.headers.has("forwarded") || request.headers.has("x-real-ip")) return false;
  // Next itself supplies these headers before calling a route. Accept only its
  // exact loopback values; external addresses, lists and cross-host forwarding fail.
  const forwardHost = request.headers.get("x-forwarded-host"), forwardPort = request.headers.get("x-forwarded-port");
  const forwardProto = request.headers.get("x-forwarded-proto"), forwardFor = request.headers.get("x-forwarded-for");
  if ((forwardHost && forwardHost !== "127.0.0.1:5000") || (forwardPort && forwardPort !== "5000")
    || (forwardProto && forwardProto !== "http")
    || (forwardFor && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(forwardFor))) return false;
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  return (!origin || origin === localOrigin) && (!site || ["same-origin", "none"].includes(site));
}

export function createPublishedPreviewService(dependencies: {
  store?: ReturnType<typeof createPublishedSnapshotStore>;
  capture?: (env: Environment) => Promise<PublishedSnapshot>;
} = {}) {
  const store = dependencies.store ?? createPublishedSnapshotStore();
  const take = dependencies.capture ?? (async (env: Environment) => capture(await createPublishedReader(env)) as Promise<PublishedSnapshot>);
  let pending: Promise<PublishedPreviewState> | null = null;
  return {
    async refresh(env: Environment = process.env): Promise<PublishedPreviewState> {
      // Check every caller before consulting shared in-flight or persisted state.
      if (!formalCatalogPreviewEnabled(env)) throw new Error("PUBLISHED_PREVIEW_LOCAL_ONLY");
      if (pending) return pending;
      pending = (async () => {
        const lastAttemptAt = new Date().toISOString();
        try {
          const snapshot = await store.save(await take(env));
          return { schema: "published-configuration-preview.v1", status: "online", lastSuccessfulAt: snapshot.observedAt,
            lastAttemptAt, servedFrom: "live", snapshot } as const;
        } catch {
          const cached = await store.read();
          if (cached.state !== "valid") throw new PublishedPreviewUnavailable(cached.state);
          return { schema: "published-configuration-preview.v1", status: "offline", lastSuccessfulAt: cached.snapshot.observedAt,
            lastAttemptAt, servedFrom: "disk", snapshot: cached.snapshot } as const;
        }
      })();
      try { return await pending; } finally { pending = null; }
    },
  };
}

export const publishedPreviewService = createPublishedPreviewService();
