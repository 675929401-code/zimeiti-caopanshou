export type CreationCenterIcon =
  | "chat"
  | "image"
  | "video"
  | "shortDrama"
  | "storyboard"
  | "canvas"
  | "cover"
  | "voice"
  | "tools"
  | "assets"
  | "digitalHuman";

export type CreationCenterAccent = "cyan" | "violet" | "amber" | "rose" | "emerald";

export type CreationCenterStatus = "ready" | "beta" | "paused";

export type ModelMetricKey = "chat" | "image" | "video";

export interface CreationCapability {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  href: string | null;
  icon: CreationCenterIcon;
  accent: CreationCenterAccent;
  status: CreationCenterStatus;
  metric?: ModelMetricKey;
}

export interface CreationShowcase {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  kind: "image" | "video";
  source: string;
  poster?: string;
  accent: CreationCenterAccent;
}

export interface ModelSummary {
  chat: number;
  image: number;
  video: number;
  videoAvailable: number;
  state: "loading" | "ready" | "partial" | "error";
}
