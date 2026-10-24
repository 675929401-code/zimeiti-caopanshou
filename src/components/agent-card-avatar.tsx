"use client";

import { useRef, useState, type CSSProperties, type ImgHTMLAttributes } from "react";

type AgentCardAvatarProps = {
  src?: string;
  fallbackSrc?: string;
  name: string;
  width: number;
  height: number;
  borderRadius: CSSProperties["borderRadius"];
  backgroundColor: string;
  loading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
  fetchPriority?: ImgHTMLAttributes<HTMLImageElement>["fetchPriority"];
};

export function AgentCardAvatar(props: AgentCardAvatarProps) {
  // A new identity owns a new request state, even while an older image is loading.
  return <AvatarRequest key={JSON.stringify([props.src, props.fallbackSrc, props.name])} {...props} />;
}

function AvatarRequest({ src, fallbackSrc, name, width, height, borderRadius, backgroundColor, loading, fetchPriority }: AgentCardAvatarProps) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<"primary" | "fallback">("primary");
  const [status, setStatus] = useState<"loading" | "ready" | "fallback" | "failed" | "empty">(src ? "loading" : "empty");
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const busyRef = useRef(false);
  const imageSrc = source === "primary" ? src : fallbackSrc;
  const hasImage = !!imageSrc && status !== "failed" && status !== "empty";
  const reason = status === "empty" ? "未设置头像" : status === "failed" ? "头像加载失败" : "头像正在加载";

  return (
    <span
      data-avatar-state={status}
      className="relative block shrink-0 overflow-hidden"
      style={{ width, height, borderRadius, backgroundColor }}
    >
      {(status === "loading" || !hasImage) && (
        <span
          role="img"
          aria-label={`${name}：${reason}`}
          className="absolute inset-0 flex items-center justify-center"
          style={{ color: "#fff", fontSize: Math.max(12, Math.min(width, height) * 0.38), fontWeight: 600 }}
          title={reason}
        >
          {name[0] || "?"}
        </span>
      )}
      {hasImage && (
        <img
          key={`${attempt}:${source}`}
          ref={imageRef}
          src={imageSrc}
          alt={name}
          width={Math.max(1, Math.round(width))}
          height={Math.max(1, Math.round(height))}
          loading={loading}
          decoding="async"
          fetchPriority={fetchPriority}
          draggable={false}
          onLoad={(event) => {
            if (imageRef.current !== event.currentTarget) return;
            busyRef.current = false;
            setStatus(source === "fallback" ? "fallback" : "ready");
          }}
          onError={(event) => {
            if (imageRef.current !== event.currentTarget) return;
            if (source === "primary") {
              setPrimaryFailed(true);
              if (fallbackSrc && fallbackSrc !== src) {
                setSource("fallback");
                setStatus("loading");
                return;
              }
            }
            busyRef.current = false;
            setStatus("failed");
          }}
          style={{ position: "relative", width: "100%", height: "100%", objectFit: "cover", borderRadius, display: "block", opacity: status === "loading" ? 0 : 1 }}
        />
      )}
      {src && primaryFailed && (
        <button
          type="button"
          data-avatar-retry
          aria-label={`重试${name}头像`}
          title={status === "loading" ? "正在重新加载头像" : "重试原头像"}
          disabled={status === "loading"}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (busyRef.current || status === "loading") return;
            busyRef.current = true;
            setSource("primary");
            setStatus("loading");
            setAttempt((value) => value + 1);
          }}
          className="absolute inset-x-1 bottom-1 z-[1] rounded border border-white/40 bg-black/75 px-1 py-0.5 text-[10px] leading-tight text-white hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-wait disabled:opacity-70"
        >
          {status === "loading" ? "加载中" : "重试"}
        </button>
      )}
    </span>
  );
}
