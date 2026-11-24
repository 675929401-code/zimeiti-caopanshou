'use client';
import { useEffect, useRef, useState } from 'react';
import { composeDetailImages, type ExportFormat } from './detail-export';

export function DetailExportPanel({ ids, format, width, disabled }: { ids: (string | undefined)[]; format: ExportFormat; width: number; disabled: boolean }) {
  const [files, setFiles] = useState<{ url: string; name: string; width: number; height: number }[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);
  useEffect(() => () => {
    controller.current?.abort();
    urls.current.forEach(url => URL.revokeObjectURL(url));
  }, []);
  const missing = ids.filter(id => !id).length;
  async function prepare() {
    if (controller.current || missing || !ids.length) return;
    const current = new AbortController();
    controller.current = current;
    setLoading(true); setError('');
    try {
      const results = await composeDetailImages(ids as string[], width, format, current.signal);
      if (current.signal.aborted) return;
      const downloads = results.map(({ blob, ...file }) => ({ ...file, url: URL.createObjectURL(blob) }));
      urls.current = downloads.map(file => file.url);
      setFiles(downloads);
    } catch (e) {
      if (!current.signal.aborted) setError(e instanceof Error ? e.message : '导出失败，请重试');
    } finally {
      if (!current.signal.aborted) setLoading(false);
      controller.current = null;
    }
  }
  return <section className="detail-export" aria-label="商详交付文件">
    {!files.length && <button type="button" disabled={disabled || loading || !!missing || !ids.length} onClick={prepare}>{loading ? '正在拼接…' : '准备连续长图与编号切片'}</button>}
    {missing > 0 && <span>当前方案还有 {missing} 屏缺少成图</span>}
    {files.map(file => <a key={file.name} href={file.url} download={file.name}>{file.name} · {file.width}×{file.height}</a>)}
    {error && <span role="alert">{error}</span>}
  </section>;
}
