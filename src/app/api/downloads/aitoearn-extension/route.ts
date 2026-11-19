import { createHash } from "node:crypto";
import { PUBLISHING_PLUGIN_DOWNLOADS } from "@/lib/publishing-native";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { version, sha256, verifiedPackageSource } = PUBLISHING_PLUGIN_DOWNLOADS;
const downloadName = `aitoearn-extension-v${version}.crx`;
const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const upstream = await fetch(verifiedPackageSource, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/x-chrome-extension, application/octet-stream, */*" },
    });
    if (!upstream.ok) {
      return Response.json({ code: "PLUGIN_DOWNLOAD_UNAVAILABLE", error: "插件安装包暂不可下载，请稍后重试" }, { status: 503, headers: noStore });
    }
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sha256 || bytes[0] !== 0x43 || bytes[1] !== 0x72 || bytes[2] !== 0x32 || bytes[3] !== 0x34) {
      return Response.json({ code: "PLUGIN_DOWNLOAD_INTEGRITY_INVALID", error: "插件安装包校验失败，已阻止下载" }, { status: 502, headers: noStore });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/x-chrome-extension",
        "Content-Disposition": `attachment; filename="${downloadName}"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ code: "PLUGIN_DOWNLOAD_UNAVAILABLE", error: "插件安装包暂不可下载，请稍后重试" }, { status: 503, headers: noStore });
  }
}
