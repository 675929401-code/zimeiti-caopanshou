import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE_ROOT = path.resolve(
  PROJECT_ROOT,
  "../../../03_知识库/自媒体操盘手长期知识库/08_智能体与数据链/网站功能推广师V2.0候选包/agent-build/自媒体获客文案操盘手",
);
const OUTPUT_PATH = path.join(PROJECT_ROOT, "src/generated/website-promoter-knowledge.v1.json");

const SOURCE_FILES = Object.freeze({
  pains: "知识库/数据/自媒体用户痛点总库.v2.json",
  evidence: "知识库/数据/抖音达人作品研究样本.v1.json",
  topics: "热点库/当前选题菜单.v1.json",
  capabilities: "知识库/数据/项目能力证据卡.v1.json",
});

function parseArguments(argv) {
  const sourceArgument = argv.find((argument) => argument.startsWith("--source-root="));
  return {
    sourceRoot: sourceArgument ? path.resolve(sourceArgument.slice("--source-root=".length)) : DEFAULT_SOURCE_ROOT,
    verify: argv.includes("--verify"),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function asText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_${field}`);
  return value.trim();
}

function asStringArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`INVALID_${field}`);
  return value.map((entry, index) => asText(entry, `${field}_${index}`));
}

async function loadSource(sourceRoot, sourceKey, relativePath) {
  const absolutePath = path.join(sourceRoot, relativePath);
  const raw = await readFile(absolutePath, "utf8");
  return {
    sourceKey,
    relativePath: relativePath.replaceAll("\\", "/"),
    raw,
    sha256: sha256(raw),
    value: JSON.parse(raw),
  };
}

function requireUnique(items, key, expectedCount) {
  if (!Array.isArray(items) || items.length !== expectedCount) {
    throw new Error(`INVALID_${key.toUpperCase()}_COUNT:${Array.isArray(items) ? items.length : "not-array"}`);
  }
  const values = items.map((item) => asText(item[key], key));
  if (new Set(values).size !== values.length) throw new Error(`DUPLICATE_${key.toUpperCase()}`);
}

function latestDeclaredDate(sourceDates) {
  const parsed = Object.values(sourceDates)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => right.time - left.time);
  if (!parsed.length) throw new Error("SOURCE_DATE_MISSING");
  return parsed[0].value;
}

async function buildSnapshot(sourceRoot) {
  const loaded = await Promise.all(
    Object.entries(SOURCE_FILES).map(([key, relativePath]) => loadSource(sourceRoot, key, relativePath)),
  );
  const byKey = Object.fromEntries(loaded.map((entry) => [entry.sourceKey, entry.value]));
  const painSource = byKey.pains;
  const evidenceSource = byKey.evidence;
  const topicSource = byKey.topics;
  const capabilitySource = byKey.capabilities;

  requireUnique(painSource.pains, "pain_id", 160);
  requireUnique(evidenceSource.samples, "sample_id", 65);
  requireUnique(topicSource.topics, "topic_id", 12);
  requireUnique(capabilitySource.capabilities, "capability_id", 7);

  const sourceDates = {
    pains: asText(painSource.generated_at, "pains_generated_at"),
    evidence: asText(evidenceSource.built_at, "evidence_built_at"),
    topics: asText(topicSource.generated_at, "topics_generated_at"),
    capabilities: asText(capabilitySource.verified_at, "capabilities_verified_at"),
  };
  const sourceFiles = loaded
    .map((entry) => ({ key: entry.sourceKey, path: entry.relativePath, sha256: entry.sha256 }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const sourceManifestSha256 = sha256(canonicalJson(sourceFiles));

  const snapshotWithoutHash = {
    schema_version: "website_promoter_knowledge_snapshot.v1",
    agent_id: "agent-1787163730859-vecrr6",
    knowledge_base_id: asText(painSource.knowledge_base_id, "knowledge_base_id"),
    compiled_from_latest_source_at: latestDeclaredDate(sourceDates),
    source_dates: sourceDates,
    source_manifest_sha256: sourceManifestSha256,
    source_files: sourceFiles,
    counts: { pains: 160, evidence: 65, topics: 12, capabilities: 7 },
    runtime_contract: {
      knowledge_mode: "bundled_snapshot_retrieval",
      agent_id: "agent-1787163730859-vecrr6",
      isolation: "exact_agent_id",
      route: "/api/llm",
      max_context_characters: 8500,
    },
    topic_snapshot: {
      menu_id: asText(topicSource.menu_id, "menu_id"),
      chain_id: asText(topicSource.chain_id, "chain_id"),
      status: asText(topicSource.snapshot_status, "snapshot_status"),
      valid_until: asText(topicSource.valid_until, "topic_valid_until"),
      limitations: asStringArray(topicSource.topics[0]?.risk_notes ?? [], "topic_limitations"),
    },
    pains: painSource.pains.map((pain) => ({
      pain_id: asText(pain.pain_id, "pain_id"),
      category_id: asText(pain.category_id, "category_id"),
      category: asText(pain.category, "category"),
      stage: asText(pain.lifecycle_stage, "lifecycle_stage"),
      question: asText(pain.user_question, "user_question"),
      scene: asText(pain.typical_scene, "typical_scene"),
      emotions: asStringArray(pain.emotions, "emotions"),
      job: asText(pain.job_to_be_done, "job_to_be_done"),
      bridges: asStringArray(pain.candidate_business_bridges, "candidate_business_bridges"),
      evidence_status: asText(pain.evidence_status, "pain_evidence_status"),
      evidence_refs: asStringArray(pain.evidence_refs ?? [], "pain_evidence_refs"),
      source_date: sourceDates.pains,
    })),
    evidence: evidenceSource.samples.map((sample) => ({
      evidence_id: asText(sample.sample_id, "sample_id"),
      source_type: asText(sample.source_type, "source_type"),
      creator: asText(sample.creator, "creator"),
      title: asText(sample.title, "sample_title"),
      url: asText(sample.url, "sample_url"),
      pain: asText(sample.pain_summary, "pain_summary"),
      hook: asText(sample.hook_mechanism, "hook_mechanism"),
      structure: asText(sample.content_structure, "content_structure"),
      visible_metrics: asText(sample.visible_metrics_snapshot, "visible_metrics_snapshot"),
      metric_note: asText(sample.metric_note, "metric_note"),
      bridge: asText(sample.candidate_bridge, "candidate_bridge"),
      evidence_status: asText(sample.evidence_status, "sample_evidence_status"),
      source_date: asText(sample.collected_at, "sample_collected_at"),
    })),
    topics: topicSource.topics.map((topic) => ({
      topic_id: asText(topic.topic_id, "topic_id"),
      title: asText(topic.title, "topic_title"),
      audience: asText(topic.target_audience, "target_audience"),
      pain_id: asText(topic.pain_id, "topic_pain_id"),
      pain: asText(topic.pain_summary, "topic_pain_summary"),
      why_now: asText(topic.why_now, "why_now"),
      lifecycle: asText(topic.lifecycle, "topic_lifecycle"),
      total_score: Number(topic.scores?.total ?? 0),
      evidence_axes: topic.evidence_axes ?? {},
      hooks: asStringArray(topic.suggested_hooks, "suggested_hooks"),
      structure: asText(topic.suggested_structure, "suggested_structure"),
      formats: asStringArray(topic.suggested_formats, "suggested_formats"),
      bridge: asText(topic.business_bridge, "business_bridge"),
      evidence_refs: asStringArray(topic.source_refs, "source_refs"),
      source_date: asText(topic.collected_at, "topic_collected_at"),
      valid_until: asText(topic.valid_until, "topic_item_valid_until"),
    })),
    capabilities: capabilitySource.capabilities.map((capability) => ({
      capability_id: asText(capability.capability_id, "capability_id"),
      name: asText(capability.name, "capability_name"),
      status: asText(capability.status, "capability_status"),
      solves: asStringArray(capability.solves, "capability_solves"),
      public_claim: asText(capability.public_claim, "public_claim"),
      forbidden_claim: asText(capability.forbidden_claim, "forbidden_claim"),
      evidence: asStringArray(capability.evidence, "capability_evidence"),
      cta: asStringArray(capability.cta, "capability_cta"),
      source_date: sourceDates.capabilities,
    })),
  };
  const snapshotSha256 = sha256(canonicalJson(snapshotWithoutHash));
  return {
    ...snapshotWithoutHash,
    snapshot_id: `wps-${snapshotSha256.slice(0, 16)}`,
    snapshot_sha256: snapshotSha256,
  };
}

const { sourceRoot, verify } = parseArguments(process.argv.slice(2));
const snapshot = await buildSnapshot(sourceRoot);
const output = `${JSON.stringify(snapshot, null, 2)}\n`;

if (verify) {
  const existing = await readFile(OUTPUT_PATH, "utf8");
  if (existing !== output) throw new Error("WEBSITE_PROMOTER_KNOWLEDGE_SNAPSHOT_DRIFT");
} else {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, output, "utf8");
}

console.log(JSON.stringify({
  valid: true,
  mode: verify ? "verify" : "write",
  output: path.relative(PROJECT_ROOT, OUTPUT_PATH).replaceAll("\\", "/"),
  snapshot_id: snapshot.snapshot_id,
  snapshot_sha256: snapshot.snapshot_sha256,
  source_manifest_sha256: snapshot.source_manifest_sha256,
  counts: snapshot.counts,
}, null, 2));
