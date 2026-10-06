import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveReferenceAudioDirectory } from "@/lib/runtime-paths";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function resolveVoiceDatabasePath() {
  const configured = process.env.VOICE_SQLITE_PATH?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error("VOICE_SQLITE_PATH must be an absolute path");
  const databasePath = path.resolve(configured);
  const stats = fs.statSync(databasePath);
  if (!stats.isFile() || stats.size <= 0) throw new Error("voice database is missing or empty");
  const descriptor = fs.openSync(databasePath, "r");
  try {
    const header = Buffer.alloc(16);
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (header.toString("utf8") !== "SQLite format 3\0") throw new Error("voice database header is invalid");
  } finally {
    fs.closeSync(descriptor);
  }
  return { databasePath, bytes: stats.size };
}

export async function GET() {
  try {
    if (process.env.NODE_ENV !== "production" || process.env.COZE_PROJECT_ENV !== "PROD") {
      throw new Error("release readiness is only valid in production mode");
    }
    const releaseId = process.env.RELEASE_ID?.trim();
    const commitSha = process.env.DEPLOY_COMMIT_SHA?.trim().toLowerCase();
    if (!releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/u.test(releaseId)) throw new Error("RELEASE_ID is invalid");
    if (!commitSha || !/^[0-9a-f]{40,64}$/u.test(commitSha)) throw new Error("DEPLOY_COMMIT_SHA is invalid");
    const buildId = process.env.EXPECTED_BUILD_ID?.trim();
    if (!buildId || !/^[A-Za-z0-9._-]{1,256}$/u.test(buildId)) throw new Error("EXPECTED_BUILD_ID is invalid");
    if (buildId !== commitSha) throw new Error("Voice EXPECTED_BUILD_ID must equal DEPLOY_COMMIT_SHA");
    const database = resolveVoiceDatabasePath();
    const referenceAudioDirectory = resolveReferenceAudioDirectory();
    fs.accessSync(referenceAudioDirectory, fs.constants.R_OK | fs.constants.W_OK);
    const [voices, users, models] = await Promise.all([
      prisma.voice.count(),
      prisma.user.count(),
      prisma.modelConfig.count(),
    ]);
    return NextResponse.json({
      ready: true,
      service: "voice",
      releaseId,
      commitSha,
      buildId,
      checks: {
        database: { bytes: database.bytes, voices, users, models },
        referenceAudioReady: true,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ready: false,
      service: "voice",
      releaseId: process.env.RELEASE_ID || null,
      commitSha: process.env.DEPLOY_COMMIT_SHA || null,
      buildId: null,
      code: "RELEASE_NOT_READY",
      error: error instanceof Error ? error.message : String(error),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
