#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const root = process.cwd();
const [
  proxySource,
  securityEdgeSource,
  nginxSource,
  rendererSource,
  brandingRouteSource,
  brandAuthoritySource,
  siteConfigRouteSource,
  publicCatalogSource,
  nginxVerifierSource,
] = await Promise.all([
  fs.readFile(path.resolve(root, "src/proxy.ts"), "utf8"),
  fs.readFile(path.resolve(root, "src/lib/security-edge.ts"), "utf8"),
  fs.readFile(path.resolve(root, "deploy/nginx/agent-hub.vnext.conf.example"), "utf8"),
  fs.readFile(path.resolve(root, "scripts/render-nginx-config-vnext.mjs"), "utf8"),
  fs.readFile(path.resolve(root, "src/app/api/branding/route.ts"), "utf8"),
  fs.readFile(path.resolve(root, "src/lib/server/brand-authority.ts"), "utf8"),
  fs.readFile(path.resolve(root, "src/app/api/site-config/route.ts"), "utf8"),
  fs.readFile(path.resolve(root, "src/lib/youcai-public-catalog.ts"), "utf8"),
  fs.readFile(path.resolve(root, "scripts/verify-render-nginx-config-vnext.mjs"), "utf8"),
]);

const activeNginx = nginxSource
  .split(/\r?\n/u)
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-readonly-domain-tls-brand-audit",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

async function tableFact(table) {
  const exists = Boolean((await client.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${table}`])).rows[0]?.exists);
  if (!exists) return { table, exists: false, count: null };
  const safe = `"${table.replaceAll('"', '""')}"`;
  const count = Number((await client.query(`SELECT count(*)::integer AS count FROM public.${safe}`)).rows[0].count);
  return { table, exists: true, count };
}

await client.connect();
let began = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );
  await client.query("BEGIN READ ONLY");
  began = true;
  const tables = [];
  for (const table of [
    "platform_brand_profiles",
    "platform_brand_revisions",
    "platform_brand_assets",
    "platform_brand_events",
    "tenants",
    "sites",
    "site_hostnames",
    "site_brand_releases",
    "domain_claims",
    "domain_hostnames",
    "domain_verification_attempts",
    "domain_tls_probes",
    "domain_brand_release_bindings",
    "domain_release_audits",
  ]) {
    tables.push(await tableFact(table));
  }
  const applied = (await client.query(
    `SELECT version::text AS version
       FROM supabase_migrations.schema_migrations
      WHERE version::text = ANY($1::text[])
      ORDER BY version::text`,
    [["20261002120000", "20261002200000", "20261002210000"]],
  )).rows.map((row) => row.version);
  await client.query("ROLLBACK");
  began = false;

  console.log(JSON.stringify({
    passed: true,
    mode: "local-read-only-no-network",
    database: {
      host: runtime.ownerConnection.host,
      port: Number(runtime.ownerConnection.port),
      name: runtime.ownerConnection.database,
      localOnly: runtime.localOnly,
    },
    runtimeFacts: {
      proxy: {
        readsHostForSecurityHeaders: proxySource.includes('request.headers.get("host")'),
        browserWritesRequireSameHost: securityEdgeSource.includes('reason: "host_mismatch"'),
        trustedHostSiteResolutionPresent: proxySource.includes("site_hostnames")
          || proxySource.includes("resolveTrustedHost"),
        unknownHostHardRejectPresent: /UNKNOWN_HOST|status:\s*421/u.test(proxySource),
      },
      nginxTemplate: {
        serverNamePlaceholder: activeNginx.includes("server_name __SERVER_NAMES__;"),
        defaultServerPresent: /listen\s+[^;]*default_server/u.test(activeNginx),
        unknownHost421Present: /return\s+421\s*;/u.test(activeNginx),
        unknownHost404CatchAllPresent: /server_name\s+_\s*;[\s\S]*return\s+404\s*;/u.test(activeNginx),
        forwardsObservedHost: activeNginx.includes("proxy_set_header Host $host;"),
        clearsForwardedHost: activeNginx.includes('proxy_set_header X-Forwarded-Host "";'),
      },
      nginxRenderer: {
        validatesAsciiHostnames: rendererSource.includes("invalid production hostname"),
        performsIdnaNormalization: /domainToASCII|punycode/iu.test(rendererSource),
        deduplicatesServerNames: rendererSource.includes("!normalized.includes(hostname)"),
      },
      branding: {
        publicRouteReadsPublishedPlatformBrand: brandingRouteSource.includes("readPublishedPlatformBranding"),
        authorityReadsPublishedBrandRpc: brandAuthoritySource.includes('rpc("read_published_platform_brand")'),
        hostOrSiteScopedRead: /site_key|hostname|headers\.get\(["']host/iu.test(brandingRouteSource),
      },
      siteConfig: {
        returnsStaticCatalog: siteConfigRouteSource.includes("getPublicSiteConfig()"),
        requestHostInput: /NextRequest|headers\.get\(["']host/iu.test(siteConfigRouteSource),
        catalogCachedInProcess: publicCatalogSource.includes("siteConfigCache ??="),
      },
      localDomainReferences: {
        referenceOnly: true,
        nginxContractMentionsLegacyNames: nginxVerifierSource.includes("zyuani8.com")
          && nginxVerifierSource.includes("zycheni9.com"),
        verifiedCurrentDns: null,
        verifiedCurrentTls: null,
        verifiedUnknownHostResponse: null,
      },
    },
    appliedRelevantMigrations: applied,
    tables,
    conclusion: {
      domainReleaseMigrationApplied: applied.includes("20261002210000"),
      dnsResolverConnected: false,
      tlsIssuerConnected: false,
      httpsProbeWorkerConnected: false,
      gatewayConnectorConnected: false,
      trustedHostResolutionConnected: false,
      unknownHostHardRejectActive: false,
      currentFormalDomainVerifiedByThisAudit: false,
    },
    externalCalls: 0,
    dnsWrites: 0,
    tlsWrites: 0,
    gatewayWrites: 0,
    formalDomainChanges: 0,
    productionWrites: 0,
    transactionRolledBack: true,
  }, null, 2));
} finally {
  if (began) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
