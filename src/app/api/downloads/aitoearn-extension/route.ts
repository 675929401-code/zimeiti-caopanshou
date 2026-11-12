import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OFFICIAL_EXTENSION_URL = "https://ai-to-earn.oss-cn-beijing.aliyuncs.com/comment/aitoearn-extension.crx";
const OFFICIAL_EXTENSION_SHA256 = "801a67f273c1bf6f08cf4892aec966c9b428c539795e7913fffbee718ebe28cf";
const DOWNLOAD_NAME = "aitoearn-extension-v2.1.0.crx";
const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const upstream = await fetch(OFFICIAL_EXTENSION_URL, {
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/x-chrome-extension, application/octet-stream, */*" },
    });
    if (!upstream.ok) {
      return Response.json({ code: "PLUGIN_DOWNLOAD_UNAVAILABLE", error: "插件安装包暂不可下载，请稍后重试" }, { status: 503, headers: noStore });
    }
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== OFFICIAL_EXTENSION_SHA256 || bytes[0] !== 0x43 || bytes[1] !== 0x72 || bytes[2] !== 0x32 || bytes[3] !== 0x34) {
      return Response.json({ code: "PLUGIN_DOWNLOAD_INTEGRITY_INVALID", error: "插件安装包校验失败，已阻止下载" }, { status: 502, headers: noStore });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/x-chrome-extension",
        "Content-Disposition": `attachment; filename="${DOWNLOAD_NAME}"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ code: "PLUGIN_DOWNLOAD_UNAVAILABLE", error: "插件安装包暂不可下载，请稍后重试" }, { status: 503, headers: noStore });
  }
}
