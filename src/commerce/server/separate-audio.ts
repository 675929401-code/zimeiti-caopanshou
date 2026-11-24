import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { runtimeDir } from './store';
import path from 'node:path';
import { assetBytes, deterministicAssetId, materializeAssets, publicAsset, readIdempotentAsset, withAssetLease, type Asset } from './assets';
import { runFFmpeg } from './media-tools';

export async function separateAudio(owner: string, assetId: string, format: 'mp4'|'mkv' = 'mp4') {
  if (!/^[a-f0-9-]{36}$/i.test(assetId)) throw Error('请选择一个视频素材');
  return withAssetLease(owner, assetId, async (source, guard) => {
    if (!source?.type.startsWith('video/')) throw Error('请选择当前账号的视频');
    const base = 'separate-audio/v2/' + format + '/' + source.id + '/' + source.sha256;
    const oldAudio = readIdempotentAsset(owner, base + '/audio');
    const oldVideo = readIdempotentAsset(owner, base + '/video');
    if (oldAudio && oldVideo) return { audio: publicAsset(oldAudio), video: publicAsset(oldVideo) };

    const folder = await fs.mkdtemp(path.join(runtimeDir(), 'demux-'));
    try {
      const input = path.join(folder, 'source');
      await fs.writeFile(input, await assetBytes(source));
      const audioPath = path.join(folder, 'audio.m4a'), videoPath = path.join(folder, 'video.' + format);
      const args = ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', input];
      const info = await runFFmpeg([...args, '-map', '0:v:0', '-an', '-frames:v', '1', '-f', 'null', '-'], 30_000);
      if (!/Stream #0:\d+[^\r\n]*:\s*Audio:/i.test(info)) throw Error('这个视频没有音轨，无法分离声音');
      const audioArgs = [...args, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-movflags', '+faststart'];
      try { await runFFmpeg([...audioArgs, '-c:a', 'copy', audioPath]); }
      catch { await runFFmpeg([...audioArgs, '-y', '-c:a', 'aac', audioPath]); }
      const visual = [...args, '-map', '0:v:0', '-an', '-map_metadata', '-1'];
      const muxOptions = format === 'mp4' ? ['-movflags', '+faststart'] : ['-fflags', '+bitexact'];
      try { await runFFmpeg([...visual, '-c:v', 'copy', ...muxOptions, videoPath]); }
      catch { await runFFmpeg([...visual, '-y', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', ...muxOptions, videoPath]); }

      const title = source.name.replace(/\.[^.]*$/, '').slice(0, 120);
      async function output(file: string, role: 'audio'|'video', name: string, type: string) {
        const size = (await fs.stat(file)).size;
        if (!size || size > 150 * 1024 * 1024) throw Error('分离结果超过素材大小限制');
        const bytes = await fs.readFile(file);
        const idempotencyKey = base + '/' + role;
        const asset: Asset = { id: deterministicAssetId(owner, idempotencyKey), owner, name, type, size,
          sha256:createHash('sha256').update(bytes).digest('hex'), createdAt:Date.now(), source:'generated', idempotencyKey };
        return { asset, bytes };
      }
      const audio = await output(audioPath, 'audio', title + '-音轨.m4a', 'audio/mp4');
      const video = await output(videoPath, 'video', title + '-无声.' + format, format === 'mkv' ? 'video/x-matroska' : 'video/mp4');
      return await materializeAssets(owner, [audio, video], tx => {
        tx.commit();
        return { audio: publicAsset(audio.asset), video: publicAsset(video.asset) };
      }, guard);
    } finally { await fs.rm(folder, { recursive:true, force:true }); }
  });
}