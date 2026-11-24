'use client';

import { useRef, useState } from 'react';

type Result = { name: string; url: string };
type Props = { text: string; onText: (value: string) => void };

export function MarkdownWordAction({ text, onText }: Props) {
  const [name, setName] = useState('转换文档');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 400000) throw Error('Markdown 文件最多支持 100000 个字符');
      const content = await file.text();
      if (content.length > 100000) throw Error('Markdown 文件最多支持 100000 个字符');
      setName(file.name.replace(/\.(md|markdown|txt)$/i, ''));
      onText(content);
      setResult(null);
      setError('');
    } catch (e) { setError((e as Error).message); }
  }

  async function convert() {
    if (lock.current || !text.trim()) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/commerce/studio/markdown-word', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || '文档转换失败，请重试');
      setResult(data.asset);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); lock.current = false; }
  }

  return <div className="cs-word-actions" aria-label="Markdown 转 Word">
    <input ref={fileInput} hidden type="file" accept=".md,.markdown,.txt,text/markdown,text/plain"
      onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }}/>
    <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>导入 Markdown</button>
    <input aria-label="Word 文件名" value={name} maxLength={100} onChange={e => setName(e.target.value)}/>
    <button type="button" disabled={busy || !text.trim()} onClick={() => void convert()}>{busy ? '转换中…' : '生成 Word'}</button>
    {result && <a download={result.name} href={result.url + '?download=1'}>下载 {result.name}</a>}
    {error && <span role="alert">{error}</span>}
  </div>;
}