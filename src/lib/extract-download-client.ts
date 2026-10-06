type ExtractDownloadTicketResponse = {
  download_url?: string;
  expires_at?: number;
  error?: string;
};

export async function requestExtractDownloadTicket(input: {
  token: string;
  url: string;
  assetId?: string;
  filename: string;
  mode: "download" | "play";
}) {
  if (!input.token) throw new Error("登录状态无效，请重新登录后下载");
  const response = await fetch("/api/extract/download-ticket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({ url: input.url, asset_id: input.assetId, filename: input.filename, mode: input.mode }),
  });
  const data = await response.json().catch(() => ({})) as ExtractDownloadTicketResponse;
  if (!response.ok || !data.download_url) {
    throw new Error(data.error || `无法获取媒体凭证（HTTP ${response.status}）`);
  }
  return { url: data.download_url, expiresAt: Number(data.expires_at || 0) };
}

export async function downloadExtractMedia(input: {
  token: string;
  url: string;
  assetId?: string;
  filename: string;
}) {
  const ticket = await requestExtractDownloadTicket({ ...input, mode: "download" });
  const link = document.createElement("a");
  link.href = ticket.url;
  link.download = input.filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return ticket;
}
