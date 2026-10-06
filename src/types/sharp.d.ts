declare module "sharp" {
  type SharpInput = Buffer | Uint8Array | ArrayBuffer | string | {
    create: { width: number; height: number; channels: number; background: string | Record<string, number> };
  };
  type SharpOptions = Record<string, unknown>;

  interface SharpPipeline {
    metadata(): Promise<Record<string, unknown>>;
    extract(options: Record<string, number>): SharpPipeline;
    resize(width: number, height: number, options?: { fit?: "cover" | "contain" | "fill" | "inside" | "outside"; position?: string | number; withoutEnlargement?: boolean }): SharpPipeline;
    resize(options: { width?: number; height?: number; fit?: "cover" | "contain" | "fill" | "inside" | "outside"; position?: string | number; withoutEnlargement?: boolean }): SharpPipeline;
    rotate(): SharpPipeline;
    png(options?: Record<string, unknown>): SharpPipeline;
    jpeg(options?: Record<string, unknown>): SharpPipeline;
    webp(options?: Record<string, unknown>): SharpPipeline;
    toFormat(format: "png" | "jpeg" | "webp", options?: Record<string, unknown>): SharpPipeline;
    raw(): SharpPipeline;
    toBuffer(): Promise<Buffer>;
    toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
  }

  const sharp: (input?: SharpInput, options?: SharpOptions) => SharpPipeline;

  export default sharp;
}
