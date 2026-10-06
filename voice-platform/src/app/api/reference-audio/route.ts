import { NextRequest } from 'next/server';
import { successResponse, errorResponse } from '@/lib/response';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { referenceAudioPublicUrl, resolveReferenceAudioDirectory } from '@/lib/runtime-paths';

function readMeta(): Record<string, { displayName: string }> {
  try {
    const metaFile = path.join(resolveReferenceAudioDirectory(), '.meta.json');
    if (fs.existsSync(metaFile)) {
      return JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
  } catch {}
  return {};
}

function writeMeta(meta: Record<string, { displayName: string }>) {
  const publicDir = resolveReferenceAudioDirectory();
  const metaFile = path.join(publicDir, '.meta.json');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  const temporary = `${metaFile}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`);
  if (!fs.existsSync(metaFile)) {
    fs.renameSync(temporary, metaFile);
    return;
  }
  const previous = `${metaFile}.previous-${process.pid}-${randomUUID()}`;
  fs.renameSync(metaFile, previous);
  try {
    fs.renameSync(temporary, metaFile);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(metaFile) && fs.existsSync(previous)) fs.renameSync(previous, metaFile);
    throw error;
  }
  try {
    fs.rmSync(previous, { force: true });
  } catch {
    // The new complete metadata file is already committed; stale backups can be pruned later.
  }
}

// GET /api/reference-audio — 列出所有已保存的参考音频
export async function GET() {
  try {
    const publicDir = resolveReferenceAudioDirectory();
    if (!fs.existsSync(publicDir)) {
      return successResponse({ files: [] });
    }

    const meta = readMeta();

    const files = fs.readdirSync(publicDir)
      .filter(f => /\.(mp4|mp3|wav|m4a|aac|ogg|opus|webm)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(publicDir, f));
        const customName = meta[f]?.displayName || '';
        return {
          filename: f,
          url: referenceAudioPublicUrl(f),
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          displayName: customName || parseDisplayName(f),
          customName: !!customName,
          source: f.includes('_link_') ? 'link' : 'upload',
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20);

    return successResponse({ files });
  } catch (err: any) {
    return errorResponse(err.message, 'LIST_ERROR', 500);
  }
}

// PUT /api/reference-audio — 重命名（请求体: { filename, displayName }）
export async function PUT(request: NextRequest) {
  try {
    const { filename, displayName } = await request.json();
    if (!filename) return errorResponse('缺少 filename', 'MISSING_PARAM', 400);
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return errorResponse('非法文件名', 'INVALID_FILENAME', 400);
    }

    const meta = readMeta();
    if (!displayName || displayName.trim().length === 0) {
      // 删除自定义名称，恢复默认
      delete meta[filename];
    } else {
      meta[filename] = { displayName: displayName.trim().slice(0, 50) };
    }
    writeMeta(meta);

    return successResponse({ filename, displayName: meta[filename]?.displayName || parseDisplayName(filename) });
  } catch (err: any) {
    return errorResponse(err.message, 'RENAME_ERROR', 500);
  }
}

// DELETE /api/reference-audio?filename=xxx — 删除指定音频
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get('filename');
    if (!filename) return errorResponse('缺少 filename 参数', 'MISSING_PARAM', 400);

    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return errorResponse('非法文件名', 'INVALID_FILENAME', 400);
    }

    const filepath = path.join(resolveReferenceAudioDirectory(), filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }

    // 同时清理元数据
    const meta = readMeta();
    if (meta[filename]) {
      delete meta[filename];
      writeMeta(meta);
    }

    return successResponse({ deleted: filename });
  } catch (err: any) {
    return errorResponse(err.message, 'DELETE_ERROR', 500);
  }
}

function parseDisplayName(filename: string): string {
  const name = filename.replace(/\.\w+$/, '');
  const parts = name.split('_');
  if (parts.length >= 3) {
    const source = parts[1] === 'link' ? '链接提取' : '上传文件';
    const hash = parts[2] || '';
    return `${source} (${hash})`;
  }
  return filename;
}
