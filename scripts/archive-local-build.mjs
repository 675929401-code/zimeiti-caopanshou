import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function archiveBuild(root, destination) {
  const canonicalRoot = await fs.realpath(root);
  const source = path.join(canonicalRoot, '.next');
  const archiveRoot = path.join(canonicalRoot, '.codex-backups');
  const target = path.resolve(destination);
  if (!inside(archiveRoot, target)) throw new Error('ARCHIVE_TARGET_OUTSIDE_BACKUPS');
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('BUILD_ROOT_MUST_BE_PHYSICAL_DIRECTORY');
  const parent = await fs.realpath(path.dirname(target));
  if (!inside(canonicalRoot, parent) || !inside(archiveRoot, parent)) throw new Error('ARCHIVE_PARENT_OUTSIDE_BACKUPS');
  try { await fs.lstat(target); throw new Error('ARCHIVE_TARGET_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const beforeBuildId = await fs.readFile(path.join(source, 'BUILD_ID'), 'utf8');
  // A same-volume directory rename preserves junctions without traversing their
  // targets. Never fall back to recursive move/copy or recursive deletion.
  await fs.rename(source, target);
  const afterBuildId = await fs.readFile(path.join(target, 'BUILD_ID'), 'utf8');
  if (afterBuildId !== beforeBuildId) throw new Error('ARCHIVED_BUILD_ID_CHANGED');
  return { archived: true, destination: target, buildId: afterBuildId.trim() };
}

async function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error) => { socket.destroy(); resolve(error.code !== 'ECONNREFUSED'); });
    socket.setTimeout(2000, () => { socket.destroy(); resolve(true); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const destination = process.argv[2];
    if (!destination) throw new Error('ARCHIVE_DESTINATION_REQUIRED');
    if (await portInUse(5000)) throw new Error('STOP_VERIFIED_LOCAL_PREVIEW_BEFORE_ARCHIVE');
    console.log(JSON.stringify(await archiveBuild(process.cwd(), destination)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'BUILD_ARCHIVE_FAILED');
    process.exitCode = 1;
  }
}
