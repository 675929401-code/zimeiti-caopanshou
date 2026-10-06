import fs from "node:fs/promises";
import pg from "pg";

import {
  inspectVideoModelActivationReadiness,
  videoActivationBindingSha256V2,
} from "@/lib/model-activation-gate";

const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ids = [
  "seedance-2-5-480p-i2v-lconai",
  "seedance-2-0-fast-720p-i2v-lconai",
  "grok-video-3-pro-lconai",
];

async function main() {
  const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-inspect-lconai-video-gate-readiness-local",
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT * FROM public.video_models WHERE id = ANY($1::text[]) ORDER BY id`,
      [ids],
    );
    console.log(JSON.stringify({
      readOnly: true,
      checkedAt: new Date().toISOString(),
      models: result.rows.map((row) => {
        const gate = row.api_protocol_config?.__model_activation_gate || {};
        const actualBindingSha256 = videoActivationBindingSha256V2(row);
        const readiness = inspectVideoModelActivationReadiness(row);
        return {
          id: row.id,
          state: gate.state || null,
          storedBindingMatchesActual: gate.binding_sha256 === actualBindingSha256,
          evidenceBindingMatchesActual: gate.evidence?.binding_sha256 === actualBindingSha256,
          ready: readiness.ready,
          reason: readiness.ready ? null : readiness.reason,
        };
      }),
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
