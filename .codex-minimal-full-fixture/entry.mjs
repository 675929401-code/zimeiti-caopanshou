import {executeReviewedProduction} from './window-main-fixture.mjs';
try{await executeReviewedProduction('/tmp/codex-window-fixture-only/descriptor.json','a'.repeat(64));}catch{process.stderr.write('FIXTURE_UNKNOWN\n');process.exitCode=1}
