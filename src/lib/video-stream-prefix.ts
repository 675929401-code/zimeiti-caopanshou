import { inferVideoContentType } from "@/lib/video-content-type";

/** In-memory container detection only; never materializes or backs up media. */
export async function resolveVideoStreamContentType(input: {
  response: Response;
  sourceUrl: string;
  cachedContentType?: string | null;
  fetchPrefix?: () => Promise<Response>;
}) {
  let body = input.response.body;
  const declaredType = String(input.response.headers.get("content-type") || "");
  if (/^(?:text\/html|application\/(?:json|problem\+json))(?:;|$)/iu.test(declaredType.trim())) {
    void body?.cancel().catch(() => undefined);
    return { body: null, contentType: null };
  }
  let contentType = inferVideoContentType({
    declaredContentType: declaredType,
    sourceUrl: input.sourceUrl,
    cachedContentType: input.cachedContentType,
  });
  const startsAtZero = input.response.status === 200
    || /^bytes 0-/iu.test(input.response.headers.get("content-range") || "");
  if (!contentType && body && startsAtZero) {
    try {
      const peeked = await peekStreamPrefix(body);
      body = peeked.replayBody;
      contentType = inferVideoContentType({ sourceUrl: "", prefix: peeked.prefix });
    } catch {
      void body.cancel().catch(() => undefined);
      return { body: null, contentType: null };
    }
  } else if (!contentType && body && input.fetchPrefix) {
    let probe: Response | null = null;
    try {
      probe = await input.fetchPrefix();
      const range = /^bytes 0-(\d+)\/(\d+)$/iu.exec(probe.headers.get("content-range") || "");
      const total = /\/(\d+)$/u.exec(input.response.headers.get("content-range") || "")?.[1];
      const rangeValid = probe.status === 200 || (probe.status === 206 && range
        && Number(range[1]) <= 15 && range[2] === total);
      const identityValid = ["etag", "last-modified"].every((header) =>
        !input.response.headers.has(header) || probe!.headers.get(header) === input.response.headers.get(header));
      if (rangeValid && identityValid && probe.body) {
        const peeked = await peekStreamPrefix(probe.body);
        void peeked.replayBody.cancel().catch(() => undefined);
        contentType = inferVideoContentType({ sourceUrl: "", prefix: peeked.prefix });
      } else {
        void probe.body?.cancel().catch(() => undefined);
      }
    } catch {
      void probe?.body?.cancel().catch(() => undefined);
    }
  }
  return { body, contentType };
}

export async function peekStreamPrefix(body: ReadableStream<Uint8Array>, minimumBytes = 16) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const deadline = Date.now() + 5_000;
  let readCount = 0;
  while (totalBytes < minimumBytes) {
    if (++readCount > 64 || Date.now() >= deadline) {
      void reader.cancel("media prefix limit").catch(() => undefined);
      throw new Error("VIDEO_PREFIX_LIMIT");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel("media prefix timeout").catch(() => undefined);
          reject(new Error("VIDEO_PREFIX_TIMEOUT"));
        }, Math.max(1, deadline - Date.now()));
      }),
    ]).finally(() => clearTimeout(timer));
    if (result.done) break;
    if (result.value?.byteLength) {
      chunks.push(result.value);
      totalBytes += result.value.byteLength;
    }
  }
  const prefix = new Uint8Array(Math.min(totalBytes, minimumBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, prefix.length - offset);
    prefix.set(part, offset);
    offset += part.byteLength;
    if (offset === prefix.length) break;
  }
  let replayIndex = 0;
  const replayBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (replayIndex < chunks.length) {
        controller.enqueue(chunks[replayIndex]);
        replayIndex += 1;
        return;
      }
      const result = await reader.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { prefix, replayBody };
}
