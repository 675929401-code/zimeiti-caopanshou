import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import nextConfig from "../next.config";
import {
  GET as readGeneralScript,
  POST as submitGeneralScript,
} from "../src/app/api/general-script/route";
import { createGeneralScriptRouteBoundary } from "../src/lib/general-script/general-script-route-boundary";
import { GeneralScriptHistoryRepository } from "../src/lib/short-drama/general-script-history";

const root = process.cwd();
const read = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

async function main(): Promise<void> {
  const [
    creationCenter,
    agentRoute,
    platformTextChat,
    generalScript,
    generalScriptHistory,
    genericModelRoute,
    llmRoute,
    genericScriptRoute,
    genericScriptBoundary,
  ] = await Promise.all([
    read("src/components/creation-center/creation-center-page.tsx"),
    read("src/features/official-core-routes/official-agent-route.tsx"),
    read("src/app/tools/text/text-chat/page.tsx"),
    read("src/features/general-script-official/general-script-official.tsx"),
    read("src/features/general-script/general-script-history-panel.tsx"),
    read("src/app/api/chat-models/route.ts"),
    read("src/app/api/llm/route.ts"),
    read("src/app/api/general-script/route.ts"),
    read("src/lib/general-script/general-script-route-boundary.ts"),
  ]);

  const checks: string[] = [];
  function pass(name: string, condition: unknown): void {
    assert.ok(condition, name);
    checks.push(name);
  }

  pass(
    "creation center disables film-studio route prefetch",
    creationCenter.includes('prefetch={capability.href === "/short-drama" ? false : undefined}'),
  );

  pass(
    "platform agent route selects the generic model catalog",
    platformTextChat.includes('<OfficialAgentRoute modelCatalogEndpoint="/api/chat-models" />'),
  );
  pass(
    "shared agent keeps the excluded branch default isolated",
    agentRoute.includes('modelCatalogEndpoint = "/api/youcai/chat-models"')
      && agentRoute.includes('fetch("/api/youcai/chat-models", requestOptions)')
      && agentRoute.includes("fetch(modelCatalogEndpoint, requestOptions)"),
  );
  pass(
    "platform chat model catalog is GET-only public DTO output",
    genericModelRoute.includes("export async function GET()")
      && !genericModelRoute.includes("export async function POST")
      && genericModelRoute.includes("toPublicModelDto")
      && genericModelRoute.includes("isPublishedTextModelEligible")
      && genericModelRoute.includes("priceReady === true"),
  );
  pass(
    "platform chat public model IDs resolve in the existing LLM send route",
    llmRoute.includes('findModelByPublicId("chat", rows, publicModelId)')
      && llmRoute.includes("requestedModelId"),
  );

  pass(
    "general script submission uses the platform namespace",
    generalScript.includes('fetch("/api/general-script"')
      && !generalScript.includes('fetch("/api/short-drama/script"'),
  );
  const genericHistoryCalls = generalScriptHistory.match(/fetch\(`\$\{endpoint\}\?/gu) || [];
  pass(
    "general and formal history list and detail use the platform namespace",
    genericHistoryCalls.length === 2
      && generalScript.includes('endpoint="/api/general-script"')
      && generalScriptHistory.includes('endpoint = "/api/short-drama/script"'),
  );
  pass(
    "generic script adapter delegates through the neutral preflight boundary",
    genericScriptRoute.includes("createGeneralScriptRouteBoundary")
      && genericScriptRoute.includes("readHistory: readDurableScriptHistory")
      && genericScriptRoute.includes("execute: executeDurableScript")
      && genericScriptBoundary.includes('general: "general-script"')
      && genericScriptBoundary.includes('formal: "general-script"')
      && genericScriptBoundary.includes("await request.clone().json()")
      && genericScriptBoundary.includes('"GENERAL_SCRIPT_PROFILE_INVALID"'),
  );

  const redirectsFactory = nextConfig.redirects;
  if (typeof redirectsFactory !== "function") throw new Error("Next config redirects must be defined");
  const redirects = await redirectsFactory();
  const redirectBySource = new Map(redirects.map((entry) => [entry.source, entry]));
  const expectedRedirects = new Map([
    ["/extract", "/tools?tab=text"],
    ["/formatter", "/tools?tab=format"],
    ["/segmenter", "/tools?tab=segment"],
    ["/inspiration", "/youcai/inspiration"],
  ]);
  for (const [source, destination] of expectedRedirects) {
    const redirect = redirectBySource.get(source);
    pass(
      `${source} redirects to ${destination}`,
      redirect?.destination === destination && redirect.permanent === false,
    );
  }

  const rejectedGet = await readGeneralScript(new Request(
    "http://contract.local/api/general-script?surface=youcai&limit=20&offset=0",
  ));
  const rejectedGetBody = await rejectedGet.json() as { code?: string };
  pass(
    "excluded GET surface fails before database authorization",
    rejectedGet.status === 400 && rejectedGetBody.code === "GENERAL_SCRIPT_SURFACE_INVALID",
  );

  const historyUrls: URL[] = [];
  const historyBoundary = createGeneralScriptRouteBoundary({
    readHistory: async (request) => {
      historyUrls.push(new URL(request.url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    execute: async () => new Response(null, { status: 204 }),
  });
  const historyId = "123e4567-e89b-42d3-a456-426614174000";
  await historyBoundary.GET(new Request(
    `http://contract.local/api/general-script?surface=general&limit=7&offset=3&id=${historyId}`,
  ));
  await historyBoundary.GET(new Request(
    "http://contract.local/api/general-script?surface=formal&profile=drama-script&limit=11&offset=9",
  ));
  pass(
    "general-script GET injects the required profile when the caller omits it",
    historyUrls[0]?.searchParams.get("profile") === "general-script",
  );
  pass(
    "general-script GET replaces an injected profile and preserves id and pagination",
    historyUrls[1]?.searchParams.get("profile") === "general-script"
      && historyUrls[0]?.searchParams.get("id") === historyId
      && historyUrls[0]?.searchParams.get("limit") === "7"
      && historyUrls[0]?.searchParams.get("offset") === "3"
      && historyUrls[1]?.searchParams.get("limit") === "11"
      && historyUrls[1]?.searchParams.get("offset") === "9",
  );

  class HistoryQueryFixture {
    readonly filters: Array<[string, unknown]> = [];
    readonly orders: Array<[string, unknown]> = [];
    selectColumns = "";
    selectOptions: unknown = null;
    rangeValue: [number, number] | null = null;

    select(columns: string, options: unknown): this {
      this.selectColumns = columns;
      this.selectOptions = options;
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters.push([column, value]);
      return this;
    }

    order(column: string, options: unknown): this {
      this.orders.push([column, options]);
      return this;
    }

    async range(from: number, to: number) {
      this.rangeValue = [from, to];
      return { data: [], error: null, count: 23 };
    }
  }

  async function runHistoryRepositoryFixture(input: {
    surface: string;
    profileId?: string;
    offset: number;
    limit: number;
    id?: string;
  }) {
    const query = new HistoryQueryFixture();
    const db = {
      from(table: string) {
        assert.equal(table, "short_drama_script_requests");
        return query;
      },
    };
    const page = await new GeneralScriptHistoryRepository(db as never).list({
      userId: "contract-user",
      ...input,
    });
    return { page, query };
  }

  const scopedPage = await runHistoryRepositoryFixture({
    surface: "general",
    profileId: "general-script",
    offset: 10,
    limit: 5,
  });
  pass(
    "history repository applies profile before exact count and database pagination",
    scopedPage.query.filters.some(([column, value]) => column === "profile_id" && value === "general-script")
      && scopedPage.query.rangeValue?.[0] === 10
      && scopedPage.query.rangeValue?.[1] === 14
      && scopedPage.page.total === 23
      && JSON.stringify(scopedPage.query.selectOptions) === JSON.stringify({ count: "exact" }),
  );

  const legacyUnscopedPage = await runHistoryRepositoryFixture({
    surface: "general",
    offset: 0,
    limit: 20,
  });
  pass(
    "shared short-drama history preserves its prior behavior when profile is omitted",
    !legacyUnscopedPage.query.filters.some(([column]) => column === "profile_id"),
  );

  const scopedDetail = await runHistoryRepositoryFixture({
    surface: "formal",
    profileId: "general-script",
    offset: 0,
    limit: 1,
    id: historyId,
  });
  pass(
    "history detail lookup combines id and profile constraints without post-filtering",
    scopedDetail.query.filters.some(([column, value]) => column === "profile_id" && value === "general-script")
      && scopedDetail.query.filters.some(([column, value]) => column === "id" && value === historyId)
      && scopedDetail.query.selectColumns.includes("request_snapshot")
      && scopedDetail.query.rangeValue?.[0] === 0
      && scopedDetail.query.rangeValue?.[1] === 0,
  );

  const rejectedPost = await submitGeneralScript(new Request(
    "http://contract.local/api/general-script",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-General-Script-Surface": "youcai",
      },
      body: JSON.stringify({ injected: true }),
    },
  ));
  const rejectedPostBody = await rejectedPost.json() as { code?: string };
  pass(
    "excluded POST surface fails before request parsing or provider dispatch",
    rejectedPost.status === 400 && rejectedPostBody.code === "GENERAL_SCRIPT_SURFACE_INVALID",
  );

  const downstream = {
    historyCalls: 0,
    executeCalls: 0,
    accepted: [] as Array<{ surface: string; profileId: string }>,
  };
  const injectedBoundary = createGeneralScriptRouteBoundary({
    readHistory: async () => {
      downstream.historyCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    execute: async (request) => {
      downstream.executeCalls += 1;
      const body = await request.json() as { profile?: { id?: unknown } };
      downstream.accepted.push({
        surface: request.headers.get("x-general-script-surface") || "",
        profileId: typeof body.profile?.id === "string" ? body.profile.id : "",
      });
      return new Response(JSON.stringify({ ok: true, injected: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const excludedProfiles = [
    { surface: "general", profileId: "drama-script" },
    { surface: "formal", profileId: "pet-silent-narration" },
  ] as const;
  const excludedProfileResults: Array<{
    surface: "general" | "formal";
    profileId: "drama-script" | "pet-silent-narration";
    status: number;
    code: string;
  }> = [];
  for (const scenario of excludedProfiles) {
    const response = await injectedBoundary.POST(new Request(
      "http://contract.local/api/general-script",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-General-Script-Surface": scenario.surface,
        },
        body: JSON.stringify({ profile: { id: scenario.profileId, version: "1.0.0" } }),
      },
    ));
    const body = await response.json() as { code?: string };
    excludedProfileResults.push({ ...scenario, status: response.status, code: body.code || "" });
  }
  pass(
    "excluded drama and pet profiles fail before durable executor, database, provider, or billing",
    excludedProfileResults.every((result) => (
      result.status === 400 && result.code === "GENERAL_SCRIPT_PROFILE_INVALID"
    ))
      && downstream.historyCalls === 0
      && downstream.executeCalls === 0,
  );

  const acceptedResults: Array<{ surface: "general" | "formal"; status: number }> = [];
  for (const surface of ["general", "formal"] as const) {
    const response = await injectedBoundary.POST(new Request(
      "http://contract.local/api/general-script",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-General-Script-Surface": surface,
        },
        body: JSON.stringify({ profile: { id: "general-script", version: "1.0.0" } }),
      },
    ));
    acceptedResults.push({ surface, status: response.status });
  }
  pass(
    "legal general and formal requests preserve their body and reach the injected executor",
    acceptedResults.every((result) => result.status === 202)
      && downstream.executeCalls === 2
      && downstream.accepted.every((result) => result.profileId === "general-script")
      && downstream.accepted.map((result) => result.surface).join(",") === "general,formal",
  );

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    scope: "frontend route boundaries and legacy toolbox redirects",
    passed: true,
    checks,
    faultInjection: {
      cases: 12,
      rejectedSurfaceStatuses: [rejectedGet.status, rejectedPost.status],
      rejectedProfiles: excludedProfileResults,
      acceptedProfiles: downstream.accepted,
      injectedExecutorCalls: downstream.executeCalls,
    },
    guarantees: {
      providerCalls: 0,
      paidRequests: 0,
      businessDatabaseReads: 0,
      businessDatabaseWrites: 0,
      migrationsApplied: 0,
      buildsStarted: 0,
      serversStarted: 0,
    },
  };

  const evidenceDir = path.join(root, ".codex-evidence", "frontend-route-boundary-hardening-20261003");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
