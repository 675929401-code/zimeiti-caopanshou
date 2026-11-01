import {executeReviewedProduction} from './window-main-fixture.mjs';
try{await executeReviewedProduction('/tmp/codex-window-fixture-only/descriptor.json','a'.repeat(64));}catch(e){process.stderr.write('FIXTURE_UNKNOWN '+String(e?.stack||e)+'\n');process.exitCode=1}
