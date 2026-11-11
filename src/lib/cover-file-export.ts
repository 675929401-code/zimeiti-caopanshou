const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
type ImageType = keyof typeof extensions;
type CoverPickerWindow = Window & {
  showSaveFilePicker?: (options: { startIn: "desktop"; suggestedName: string; excludeAcceptAllOption: boolean;
    types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
};

export function coverExportName(ratio: string, mime = "image/png") {
  return `封面-${ratio.replace(":", "x")}.${extensions[mime as ImageType] || "png"}`;
}

export async function chooseCoverFile(ratio: string, previewType?: string) {
  const host = window as CoverPickerWindow;
  if (!host.showSaveFilePicker) return null;
  const mime: ImageType = previewType && Object.hasOwn(extensions, previewType) ? previewType as ImageType : "image/png";
  try {
    const handle = await host.showSaveFilePicker({
      startIn: "desktop", suggestedName: coverExportName(ratio, mime), excludeAcceptAllOption: true,
      types: [{ description: "封面图片", accept: { [mime]: ["." + extensions[mime]] } }],
    });
    return { handle, mime };
  } catch (error) {
    // Embedded browsers can expose the API while disallowing its native UI.
    if (error instanceof DOMException && error.name === "SecurityError") return null;
    throw error;
  }
}

export async function writeCoverFile(file: { handle: FileSystemFileHandle; mime: ImageType }, blob: Blob) {
  let content = blob;
  if (blob.type.split(";")[0] !== file.mime) {
    // A legacy image can finish loading after the user picked the suggested PNG.
    const image = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法转换封面格式。");
      ctx.drawImage(image, 0, 0);
      content = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        result => result?.type === file.mime ? resolve(result) : reject(new Error("无法生成所选格式的封面。")), file.mime));
    } finally { image.close(); }
  }
  const writer = await file.handle.createWritable();
  try { await writer.write(content); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
}
