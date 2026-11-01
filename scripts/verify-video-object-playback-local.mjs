export async function main(argv = []) {
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/$/u, "");
  const taskId = String(argv[0] || "vt_69bd4594016d4d0f7da2f027e2465563bef3c997");
  if (!token || !origin) throw new Error("LOCAL_NAV_ADMIN_TOKEN/LOCAL_NAV_ORIGIN missing");

  const ticketRes = await fetch(`${origin}/api/video/access-ticket?taskId=${encodeURIComponent(taskId)}&scope=playback`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const ticket = await ticketRes.json().catch(() => ({}));
  console.log("TICKET", ticketRes.status, String(ticket?.url || "").slice(0, 60));

  const tryOne = async (label, url, headers) => {
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60000) });
    const body = Buffer.from(await res.arrayBuffer());
    const ct = String(res.headers.get("content-type") || "");
    console.log(label, res.status, ct, "bytes=" + body.length, "range=" + (res.headers.get("content-range") || "-"));
    if (ct.includes("json")) console.log(label, "BODY", body.toString("utf8").slice(0, 200));
    return res.status;
  };

  if (ticket?.url) {
    await tryOne("TICKET_PATH", new URL(ticket.url, origin).toString(), { Range: "bytes=0-65535" });
  }
  await tryOne("HEADER_PATH", `${origin}/api/video/proxy?id=${encodeURIComponent(taskId)}`, {
    Authorization: `Bearer ${token}`,
    Range: "bytes=0-65535",
  });
}
