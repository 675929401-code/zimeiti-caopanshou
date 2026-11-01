"use client";

import { useEffect, useMemo, useState } from "react";
import { displayModelAvatar, isModelAvatarImage, modelBrandAsset, modelInitial, resolveModelBrand } from "@/lib/model-brand";
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
  const avatar = String(avatarUrl || "").trim();
  const brand = resolveModelBrand(name, ...identity);
  const avatarSource = isModelAvatarImage(avatar) ? displayModelAvatar(avatar) : "";
  const brandSource = brand ? modelBrandAsset(brand) : "";
  const genericSource = modelBrandAsset("generic");
  const imageSources = [avatarSource, brandSource, genericSource].filter((source, index, values) => source && values.indexOf(source) === index);
  const [failedSources, setFailedSources] = useState<string[]>([]);

  useEffect(() => setFailedSources([]), [avatarSource, brandSource, genericSource]);

  const initial = useMemo(() => modelInitial(name), [name]);
  const imageSource = imageSources.find((source) => !failedSources.includes(source)) || "";
  const renderedKind = imageSource
    ? imageSource === avatarSource ? "avatar" : imageSource === genericSource ? "generic" : "brand"
    : "initial";

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
