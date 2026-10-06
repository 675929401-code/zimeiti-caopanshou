import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {operationsDirectory,readLatestOperation,recordOperation} from './project-operations.mjs';

const area=fs.mkdtempSync(path.join(os.tmpdir(),'project-operations-'));
const root=path.join(area,'source');fs.mkdirSync(root);
try {
  const first=recordOperation(root,{task:'验收操作日志',stage:'local-build',status:'running',sourceVersion:'R000001',summary:'开始构建',nextAction:'等待构建'});
  const second=recordOperation(root,{stage:'local-build',status:'passed',summary:'构建成功',buildId:'test-build'});
  assert.equal(second.previousId,first.id);
  assert.equal(second.task,first.task);
  assert.equal(readLatestOperation(root).buildId,'test-build');
  const dir=operationsDirectory(root);
  fs.unlinkSync(path.join(dir,'current.json'));
  assert.equal(readLatestOperation(root).id,second.id,'journal remains authoritative after projection loss');
  assert.throws(()=>recordOperation(root,{stage:'test',status:'passed',summary:'token=fixture-secret'}),/SENSITIVE/);
  fs.writeFileSync(path.join(dir,'.write.lock'),'locked');
  assert.throws(()=>recordOperation(root,{stage:'test',status:'passed',summary:'不能并行覆盖'}),/EEXIST/);
  fs.unlinkSync(path.join(dir,'.write.lock'));
  fs.appendFileSync(path.join(dir,'events.jsonl'),'{incomplete');
  assert.throws(()=>readLatestOperation(root),/INCOMPLETE/);
  console.log('PASS durable journal, task continuity, projection recovery, secret rejection, concurrent lock and interrupted-write detection');
} finally {
  const resolved=fs.realpathSync(area);
  if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('project-operations-'))throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
}
