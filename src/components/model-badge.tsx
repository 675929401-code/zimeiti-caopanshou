"use client";

import { useEffect, useMemo, useState } from "react";
import { modelInitial, resolveModelBadgeAppearance } from "@/lib/model-brand";
import styles from "./model-badge.module.css";

type ModelBadgeProps = {
  name: string;
  avatarUrl?: string | null;
  identity?: Array<string | null | undefined>;
  selected?: boolean;
  availability?: "ready" | "unavailable";
  className?: string;
  "data-video-model-avatar"?: string;
};

export function ModelBadge({
  name,
  avatarUrl,
  identity = [],
  selected = false,
  availability = "ready",
  className = "",
  "data-video-model-avatar": videoModelAvatar,
}: ModelBadgeProps) {
  const { brand, candidates } = resolveModelBadgeAppearance(name, avatarUrl, identity);
  const sourceIdentity = JSON.stringify([name, avatarUrl, identity, candidates]);
  const [failedSources, setFailedSources] = useState<string[]>([]);

  useEffect(() => setFailedSources([]), [sourceIdentity]);

  const initial = useMemo(() => modelInitial(name), [name]);
  const candidate = candidates.find(({ source }) => !failedSources.includes(source));
  const imageSource = candidate?.source || "";
  const renderedKind = candidate?.kind || "initial";

  return (
    <span
      className={`${styles.badge} ${className}`.trim()}
      aria-hidden="true"
      data-model-badge
      data-model-brand={brand || undefined}
      data-model-badge-source={renderedKind}
      data-selected={selected ? "true" : "false"}
      data-availability={availability}
      data-video-model-avatar={videoModelAvatar}
    >
      {imageSource ? (
        <img
          src={imageSource}
          alt=""
          className={styles.image}
          onError={() => setFailedSources((sources) => sources.includes(imageSource) ? sources : [...sources, imageSource])}
        />
      ) : (
        <span className={styles.initial}>{initial}</span>
      )}
    </span>
  );
}
