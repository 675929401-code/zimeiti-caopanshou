export type ExportFormat = 'PNG' | 'JPEG' | 'WEBP';
export type DetailFile = { name: string; blob: Blob; width: number; height: number };

export async function composeDetailImages(ids: string[], width: number, format: ExportFormat, signal: AbortSignal): Promise<DetailFile[]> {
  if (!ids.length || ids.length > 12 || !Number.isInteger(width) || width < 200 || width > 4096) {
    throw Error('请选择 1–12 屏，导出宽度为 200–4096 像素');
  }
  const mime = { PNG: 'image/png', JPEG: 'image/jpeg', WEBP: 'image/webp' }[format];
  const ext = { PNG: 'png', JPEG: 'jpg', WEBP: 'webp' }[format];
  const encode = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => blob?.type === mime ? resolve(blob) : reject(Error('浏览器未能按指定格式导出图片')), mime, 0.95)
  );
  const files: DetailFile[] = [];
  let totalHeight = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('浏览器无法创建图片画布');
  try {
    for (const [i, id] of ids.entries()) {
      signal.throwIfAborted();
      const response = await fetch('/api/commerce/assets/' + encodeURIComponent(id), { signal, cache: 'no-store' });
      if (!response.ok) throw Error('第 ' + (i + 1) + ' 屏读取失败，请检查登录状态与所选版本');
      const bitmap = await createImageBitmap(await response.blob());
      try {
        const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
        totalHeight += height;
        if (totalHeight > 32767 || width * totalHeight > 32000000) throw Error('长图超出浏览器画布容量，请调低导出宽度');
        canvas.width = width;
        canvas.height = height;
        if (format === 'JPEG') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
        ctx.drawImage(bitmap, 0, 0, width, height);
        files.push({ name: '商详-' + String(i + 1).padStart(2, '0') + '.' + ext, blob: await encode(canvas), width, height });
      } finally { bitmap.close(); }
    }
    canvas.width = width;
    canvas.height = totalHeight;
    let y = 0;
    for (const file of files) {
      signal.throwIfAborted();
      const bitmap = await createImageBitmap(file.blob);
      try { ctx.drawImage(bitmap, 0, y); y += file.height; } finally { bitmap.close(); }
    }
    return [{ name: '商详-连续长图.' + ext, blob: await encode(canvas), width, height: totalHeight }, ...files];
  } finally { canvas.width = canvas.height = 0; }
}
