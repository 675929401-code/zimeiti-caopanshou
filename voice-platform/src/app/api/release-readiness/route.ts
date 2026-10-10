import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveReferenceAudioDirectory } from "@/lib/runtime-paths";
import { isAuthSecurelyConfigured } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CANDIDATE_READINESS_PROFILE = "candidate-runtime-v1";
const PRODUCTION_READINESS_PROFILE = "production-full-v1";

function resolveReadinessProfile() {
  const configured = process.env.RELEASE_READINESS_PROFILE?.trim() || PRODUCTION_READINESS_PROFILE;
  if (configured !== CANDIDATE_READINESS_PROFILE && configured !== PRODUCTION_READINESS_PROFILE) {
    throw new Error("RELEASE_READINESS_PROFILE is invalid");
  }
  return configured;
}

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
  let readinessProfile: string | null = null;
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
    const buildOutputDigest = process.env.RELEASE_BUILD_OUTPUT_DIGEST?.trim().toLowerCase();
    const sourceVersion = process.env.RELEASE_SOURCE_VERSION?.trim();
    if (!buildOutputDigest || !/^[a-f0-9]{64}$/u.test(buildOutputDigest)) throw new Error("RELEASE_BUILD_OUTPUT_DIGEST is invalid");
    if (!sourceVersion || /[\u0000-\u001f\u007f]/u.test(sourceVersion)) throw new Error("RELEASE_SOURCE_VERSION is invalid");
    readinessProfile = resolveReadinessProfile();
    if (!isAuthSecurelyConfigured()) throw new Error("AUTH_SECRET must contain at least 32 UTF-8 bytes");
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
      activationReady: readinessProfile === PRODUCTION_READINESS_PROFILE,
      readinessProfile,
      service: "voice",
      releaseId,
      commitSha,
      buildId,
      buildOutputDigest,
      sourceVersion,
      checks: {
        database: { bytes: database.bytes, voices, users, models },
        referenceAudioReady: true,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ready: false,
      activationReady: false,
      readinessProfile,
      service: "voice",
      releaseId: process.env.RELEASE_ID || null,
      commitSha: process.env.DEPLOY_COMMIT_SHA || null,
      buildId: null,
      buildOutputDigest: null,
      sourceVersion: null,
      code: "RELEASE_NOT_READY",
      error: error instanceof Error ? error.message : String(error),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
