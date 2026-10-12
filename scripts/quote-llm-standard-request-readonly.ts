#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_RUNTIME = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
function fail(code: string): never { throw new Error(code); }
export function parseQuoteCliArgs(argv: string[]) {
  const options: Record<string,string> = { mode:"plan", "runtime-path":DEFAULT_RUNTIME };
  const seen = new Set<string>();
  for (const arg of argv) {
    const match = /^--(mode|runtime-path|expected-database|expected-port|expected-identity|actor-id|public-model-id|case|output|expected-source-version|expected-build-id)=(.+)$/u.exec(arg);
    if (!match || seen.has(match[1])) fail("LLM_QUOTE_ARGUMENT_INVALID");
    seen.add(match[1]); options[match[1]]=match[2].trim();
  }
  if (!["plan","readonly"].includes(options.mode)) fail("LLM_QUOTE_MODE_INVALID");
  if (options.mode === "readonly") {
    for (const key of ["expected-database","expected-port","expected-identity","actor-id","public-model-id","case","output","expected-source-version","expected-build-id"]) if (!options[key]) fail("LLM_QUOTE_ARGUMENT_REQUIRED");
    if (!/^[a-f0-9]{64}$/u.test(options["expected-identity"]) || !/^\d{1,5}$/u.test(options["expected-port"]) || !/^[A-Za-z0-9_-]+$/u.test(options["expected-database"])) fail("LLM_QUOTE_ARGUMENT_INVALID");
    if (!["short-answer","long-list","markdown-code"].includes(options.case)) fail("LLM_QUOTE_CASE_INVALID");
  }
  return options;
}
export function validateQuoteConnection(value: unknown, options: Record<string,string>, env: NodeJS.ProcessEnv) {
  if (Object.keys(env).some(key=>/^PG/iu.test(key) && env[key])) fail("LLM_QUOTE_PG_ENV_UNSAFE");
  let url: URL; try { url = new URL(String(value)); } catch { return fail("LLM_QUOTE_CONNECTION_INVALID"); }
  if (!["postgres:","postgresql:"].includes(url.protocol) || url.hostname!=="127.0.0.1" || url.port!==options["expected-port"] || decodeURIComponent(url.pathname.slice(1))!==options["expected-database"] || url.search || url.hash || !url.username || !url.password) fail("LLM_QUOTE_CONNECTION_UNVERIFIED");
  return String(value);
}
const AGENT_SELECT = "SELECT id,name,source,is_active,deleted_at,model_id,model,system_prompt,config_revision,deep_thinking_type,deduct_deep_think,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,enable_web_search,temperature,response_format,user_access,category FROM public.agents WHERE id=$1";
const MODEL_SELECT = "SELECT id,name,model_name,is_active,is_hidden,user_access,deep_thinking_type,deduct_deep_think,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,enable_web_search,temperature,response_format,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,token_rounding_unit FROM public.llm_models WHERE id=$1";
const AGENT_NUMERIC_FIELDS = ["config_revision","deep_thinking_type","deduct_deep_think","max_context_rounds","max_context_tokens","max_reply_tokens","timeout","temperature"] as const;
const MODEL_NUMERIC_FIELDS = [...AGENT_NUMERIC_FIELDS.filter(key=>key!=="config_revision"),"input_cost_per_million","output_cost_per_million","cached_cost_per_million","profit_margin","token_rounding_unit"] as const;
const INTEGER_NUMERIC_FIELDS = new Set(["config_revision","deep_thinking_type","max_context_rounds","max_context_tokens","max_reply_tokens","timeout","token_rounding_unit"]);
// pg returns numeric columns as strings; the REST transport supplies JSON numbers.
// Normalize only this transport's numeric contract, before snapshot/hash preparation.
function normalizeNumericRows(rows: Record<string,unknown>[], fields: readonly string[]) {
  return rows.map(row=>{
    const normalized={...row};
    for (const key of fields) {
      const raw=row[key]; if (raw==null) continue;
      if (typeof raw!=="number" && (typeof raw!=="string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(raw.trim()))) fail("LLM_QUOTE_NUMERIC_INVALID");
      const value=Number(raw);
      if (!Number.isFinite(value) || (INTEGER_NUMERIC_FIELDS.has(key) && !Number.isSafeInteger(value)) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("LLM_QUOTE_NUMERIC_INVALID");
      normalized[key]=value;
    }
    return normalized;
  });
}
export async function readQuoteTransaction(client: any, options: Record<string,string>, body: Record<string,unknown>, ports: any) {
  const deadline = (ports.now || Date.now)() + 20_000;
  const boundedQuery = async (sql:string,args?:unknown[]) => {
    const remaining = deadline - (ports.now || Date.now)();
    if (remaining <= 0) fail("LLM_QUOTE_TRANSACTION_TIMEOUT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([client.query(sql,args),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error("LLM_QUOTE_TRANSACTION_TIMEOUT")),remaining);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    await boundedQuery("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await boundedQuery("SET LOCAL statement_timeout='4000ms'");
    await boundedQuery("SET LOCAL lock_timeout='1000ms'");
    await boundedQuery("SET LOCAL idle_in_transaction_session_timeout='8000ms'");
    const identity = await ports.readIdentity({query:boundedQuery},"127.0.0.1");
    if (identity.fingerprint!==options["expected-identity"]) fail("LLM_QUOTE_DATABASE_IDENTITY_MISMATCH");
    const select = async (sql:string,args:unknown[] = []) => {
      if (!/^SELECT /u.test(sql)) fail("LLM_QUOTE_QUERY_FORBIDDEN");
      return (await boundedQuery(sql,args)).rows;
    };
    const snapshot = await ports.readSnapshot({
      readAgent: async (id:string)=>normalizeNumericRows(await select(AGENT_SELECT,[id]),AGENT_NUMERIC_FIELDS),
      readModel: async (id:string)=>normalizeNumericRows(await select(MODEL_SELECT,[id]),MODEL_NUMERIC_FIELDS),
      readSettings:()=>select("SELECT setting_key,setting_value FROM public.platform_settings WHERE setting_key=ANY($1::text[])",[ports.settingKeys]),
      readActor:(id:string)=>select("SELECT id,role,status,is_active FROM public.users WHERE id=$1",[id]),
      readSkills:(id:string)=>select("SELECT s.id,s.is_active FROM public.agent_skills a JOIN public.skills s ON s.id=a.skill_id WHERE a.agent_id=$1 AND a.is_enabled=true AND s.is_active=true",[id]),
    },options["actor-id"],body.agentId);
    const pins = await ports.readPins();
    if (pins.sourceVersion!==options["expected-source-version"] || pins.buildId!==options["expected-build-id"]) fail("LLM_QUOTE_RUNTIME_MISMATCH");
    const prepared=await ports.prepare(body,snapshot,options["actor-id"],options["public-model-id"],pins);
    return {schemaVersion:"llm_platform_reservation_receipt.v1",kind:"readonly_platform_reservation",caseId:options.case,
      quoteExpectation:prepared.expectation,composedPromptSha256:prepared.composedPromptSha256,
      databaseIdentity:{fingerprint:identity.fingerprint,physicalProductionIdentityProven:false},
      successfulReads:["agent","linked_model","settings","actor","active_skills"],
      platformReservationCredits:prepared.reservation.amount,platformReservationYuanEquivalent:prepared.platformReservationYuanEquivalent,
      denomination:{creditsPerYuan:prepared.billing.config.creditsPerYuan,priceSnapshot:prepared.billing.priceSnapshot},
      budgets:prepared.reservation,permissionAssessment:"not_proven_by_admin_read",spendingAuthorized:false,
      providerInvoiceUpperBound:null,totalProviderDispatchCeiling:null,sourcePins:pins};
  } finally { try { await client.query("ROLLBACK"); } finally { await client.end(); } }
}
export async function runQuoteCli(argv:string[], ports?:any) {
  const options=parseQuoteCliArgs(argv);
  if (options.mode === "plan") return {schemaVersion:"llm_platform_reservation_cli_plan.v1",mode:"plan",connections:0,secretLoads:0,fileWrites:0,
    providerCalls:0,spendingAuthorized:false,permissionAssessment:"not_proven_by_admin_read",providerInvoiceUpperBound:null,
    requirement:"Explicit readonly mode requires verified loopback database identity, actor/sample/runtime pins and stdin request; no LLM POST or credits GET is used."};
  if (ports) return ports.readonly(options);
  const inputChunks:Buffer[]=[]; let inputBytes=0;
  for await (const chunk of process.stdin) { const bytes=Buffer.from(chunk);inputBytes+=bytes.length;if(inputBytes>262144) fail("LLM_QUOTE_STDIN_TOO_LARGE");inputChunks.push(bytes); }
  let body:Record<string,unknown>;try {body=JSON.parse(Buffer.concat(inputChunks).toString("utf8"));} catch {return fail("LLM_QUOTE_STDIN_INVALID");}
  if (!body || typeof body!=="object" || Array.isArray(body)) fail("LLM_QUOTE_STDIN_INVALID");
  const runtime=JSON.parse((await readFile(options["runtime-path"],"utf8")).replace(/^\uFEFF/u,""));
  const connectionString=validateQuoteConnection(runtime.databaseUrl,options,process.env);
  const [{Client},core,identityModule]=await Promise.all([import("pg"),import("../src/lib/server/llm-standard-request-preparation"),import("./lib/database-target-identity.mjs")]);
  const client=new Client({connectionString,connectionTimeoutMillis:4000,query_timeout:5000,application_name:"llm-reservation-readonly"});
  try { await client.connect(); } catch { await client.end().catch(()=>{}); return fail("LLM_QUOTE_CONNECTION_UNKNOWN"); }
  const receipt=await readQuoteTransaction(client,options,body,{readIdentity:identityModule.readDatabaseTargetIdentity,
    readSnapshot:core.readStandardSnapshot,settingKeys:core.STANDARD_SETTING_KEYS,prepare:core.prepareStandardLlmRequest,
    readPins:async()=>({sourceVersion:JSON.parse(await readFile(path.join(ROOT,"public/version.json"),"utf8")).sourceVersion,
      buildId:(await readFile(path.join(ROOT,".next/BUILD_ID"),"utf8")).trim()})});
  await writeFile(path.resolve(options.output),JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
  return {status:"quoted",receiptSha256:(await import("node:crypto")).createHash("sha256").update(JSON.stringify(receipt,null,2)+"\n").digest("hex"),platformReservationCredits:receipt.platformReservationCredits,platformReservationYuanEquivalent:receipt.platformReservationYuanEquivalent,providerInvoiceUpperBound:null,spendingAuthorized:false};
}
if (process.argv[1] && path.resolve(process.argv[1])===path.join(ROOT,"scripts","quote-llm-standard-request-readonly.ts")) {
  runQuoteCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{
    const code=error instanceof Error && /^LLM_QUOTE_[A-Z_]+$/u.test(error.message)?error.message:"LLM_QUOTE_READ_UNKNOWN";
    console.error(JSON.stringify({status:"unknown_or_unsupported",code,providerCalls:0,spendingAuthorized:false}));process.exitCode=1;
  });
}
