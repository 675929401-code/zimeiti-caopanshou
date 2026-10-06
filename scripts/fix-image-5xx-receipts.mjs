import fs from 'node:fs';
import path from 'node:path';
const dir = 'F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/模型共享凭据/带货Agent调用回执';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let fixed = 0;
for (const f of files) {
  const p = path.join(dir, f);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.status === 'unknown' && /^IMAGE_PROVIDER_HTTP_5\d\d$/.test(j.error || '')) {
      j.status = 'failed';
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
      fixed += 1;
    }
  } catch { /* skip malformed */ }
}
console.log('修正502/5xx回执:', fixed);
