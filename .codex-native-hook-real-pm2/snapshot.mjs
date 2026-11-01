import {execFileSync} from 'node:child_process';
import {snapshotWorkers} from './fixture-hook.mjs';
const rows=JSON.parse(execFileSync('/tmp/native-hook-fixture/bin/pm2',['jlist'],{encoding:'utf8',maxBuffer:16777216}));
process.stdout.write(JSON.stringify(snapshotWorkers(rows))+'\n');
