import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";

const AcceptanceReportSchema = z.object({
  runId: z.string().trim().min(1).max(160),
  phase: z.string().trim().min(1).max(80),
  nodes: z.array(z.object({
    id: z.string().max(200),
    title: z.string().max(300),
    kind: z.string().max(40),
    assetRole: z.string().max(80).optional(),
    status: z.string().max(40),
    outputUrl: z.string().max(8000).optional(),
    prompt: z.string().max(30000).optional(),
    modelId: z.string().max(300).optional(),
    history: z.array(z.object({
      id: z.string().max(200),
      outputUrl: z.string().max(8000).optional(),
      createdAt: z.string().max(80).optional(),
    })).max(20).optional(),
  })).max(500),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const report = AcceptanceReportSchema.parse(await request.json());
  const safeRunId = report.runId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120) || "canvas-run";
  const directory = path.join(process.cwd(), ".tmp-e2e");
  const filePath = path.join(directory, `canvas-acceptance-${safeRunId}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...report,
  }, null, 2)}\n`, "utf8");
  return NextResponse.json({ ok: true, filePath: path.relative(process.cwd(), filePath) });
}
