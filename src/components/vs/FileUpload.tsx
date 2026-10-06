'use client';

import React, { useState, useCallback } from 'react';

interface FileUploadProps {
  accept?: string;
  maxSize?: number;
  onChange: (file: File) => void;
  label?: string;
}

export default function FileUpload({ accept = 'audio/*', maxSize = 15 * 1024 * 1024, onChange, label }: FileUploadProps) {
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');

  const handleFile = useCallback((f: File) => {
    if (f.size > maxSize) {
      setError(`文件大小不能超过 ${(maxSize / 1024 / 1024).toFixed(0)}MB`);
      return;
    }
    setError('');
    setFile(f);
    onChange(f);
  }, [maxSize, onChange]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  return (
    <div className="space-y-2">
      {label && <p className="text-sm font-medium text-[var(--vs-text)]">{label}</p>}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-2xl p-8 text-center transition-all duration-200 cursor-pointer bg-[var(--vs-surface)]/70 backdrop-blur-sm ${
          dragOver
            ? 'border-[var(--vs-primary)] bg-[var(--vs-control-hover)]'
            : 'border-[var(--vs-border)] hover:border-[var(--vs-primary)] hover:bg-[var(--vs-control-hover)]'
        }`}
        onClick={() => document.getElementById('file-upload-input')?.click()}
      >
        <input
          id="file-upload-input"
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {file ? (
          <div className="space-y-1">
            <svg className="w-8 h-8 mx-auto text-[var(--vs-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
            <p className="text-sm font-medium text-[var(--vs-text)]">{file.name}</p>
            <p className="text-sm text-[var(--vs-text-muted)]">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
        ) : (
          <div className="space-y-2">
            <svg className="w-10 h-10 mx-auto text-[var(--vs-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="text-sm text-[var(--vs-text-muted)]">点击或拖拽文件到此处</p>
            <p className="text-sm text-[var(--vs-text-muted)]">
              支持 WAV, MP3, OGG, M4A, AAC, PCM 格式，最大 {(maxSize / 1024 / 1024).toFixed(0)}MB
            </p>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}
    </div>
  );
}
