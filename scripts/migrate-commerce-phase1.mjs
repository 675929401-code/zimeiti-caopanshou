/**
 * 带货Agent → 主站 第一阶段迁移脚本（同进程共宿主）
 * 规则：
 *  - server/lib/components/shared/types/content → src/commerce/*（物理隔离模块）
 *  - app/api/* → src/app/api/commerce/*（API命名空间）
 *  - app 页面目录 → src/app/commerce/*（URL命名空间）
 *  - 所有相对导入按"旧根→新根"映射确定性重算；外部包导入不动
 *  - app/layout.tsx 与 app/globals.css 跳过（手工做嵌套布局适配）
 */
import fs from 'node:fs';
import path from 'node:path';

const OLD_ROOT = 'F:/总项目文件/Skill存储系统/01_网页开发项目/带货Agent/src';
const NEW_ROOT = 'F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/src';

const SKIP_FILES = new Set(['app/layout.tsx', 'app/globals.css']);

function mapTarget(rel) {
  // rel: 相对旧 src 的 posix 路径
  if (rel.startsWith('app/api/')) return 'app/api/commerce/' + rel.slice('app/api/'.length);
  if (rel === 'app/page.tsx' || rel.startsWith('app/settings/') || rel.startsWith('app/canvas-share/')
    || rel.startsWith('app/help/') || rel.startsWith('app/[...view]/') || rel === 'app/[...view]') {
    return 'app/commerce/' + rel.slice('app/'.length);
  }
  if (rel.startsWith('server/')) return 'commerce/server/' + rel.slice('server/'.length);
  if (rel.startsWith('lib/')) return 'commerce/lib/' + rel.slice('lib/'.length);
  if (rel.startsWith('components/')) return 'commerce/components/' + rel.slice('components/'.length);
  if (rel.startsWith('shared/')) return 'commerce/shared/' + rel.slice('shared/'.length);
  if (rel.startsWith('types/')) return 'commerce/types/' + rel.slice('types/'.length);
  if (rel.startsWith('content/')) return 'commerce/content/' + rel.slice('content/'.length);
  // 旧 src 根级共享类型文件
  if (!rel.includes('/') && ext2(rel) === '.ts') return 'commerce/' + rel;
  return null;
}

function ext2(rel) {
  const i = rel.lastIndexOf('.');
  return i < 0 ? '' : rel.slice(i);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(OLD_ROOT);

let copied = 0, skipped = 0, rewritten = 0;
const rewriteLog = [];

for (const oldFile of files) {
  const rel = path.relative(OLD_ROOT, oldFile).split(path.sep).join('/');
  if (SKIP_FILES.has(rel)) { skipped++; continue; }
  const newRel = mapTarget(rel);
  if (!newRel) { console.log('!! 未映射:', rel); skipped++; continue; }
  const newFile = path.join(NEW_ROOT, newRel);
  fs.mkdirSync(path.dirname(newFile), { recursive: true });

  let text = fs.readFileSync(oldFile, 'utf8');
  const ext = path.extname(oldFile);
  if (['.ts', '.tsx', '.css'].includes(ext)) {
    const fileDir = path.dirname(rel);
    text = text.replace(/(from\s+|import\s*\(\s*|require\(\s*)(['"])(\.\.?\/[^'"]*)\2/g, (m, head, q, spec) => {
      // 解析旧目标
      const oldAbs = path.posix.normalize(path.posix.join(fileDir, spec));
      const newTargetRel = mapTarget(oldAbs);
      if (!newTargetRel) return m; // 指向 commerce 树之外（外部包不可能以.开头，这里指未映射文件）
      // 计算新文件目录 → 新目标的相对路径
      const newDir = path.posix.dirname(newRel);
      let relPath = path.posix.relative(newDir, newTargetRel);
      if (!relPath.startsWith('.')) relPath = './' + relPath;
      rewritten++;
      rewriteLog.push(`${rel}: ${spec} → ${relPath}`);
      return `${head}${q}${relPath}${q}`;
    });
    // 孤例别名：@/lib/coze-extraction-result 主站真实存在，保持不变
  }
  fs.writeFileSync(newFile, text);
  copied++;
}

console.log(`复制 ${copied} 个文件，跳过 ${skipped}（layout/globals手工适配），重写相对导入 ${rewritten} 处`);
fs.writeFileSync('F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.logs/commerce-migrate-rewrites.log', rewriteLog.join('\n'));
