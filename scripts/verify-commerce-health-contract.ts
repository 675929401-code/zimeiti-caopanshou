import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../src/app/api/commerce/health/route.ts',import.meta.url),'utf8');
assert.match(source,/const kinds:Kind\[\]=\['agent','image','video'\]/);
assert.match(source,/commerceModelAcceptanceKey\(kind,id,model\.configHash\)/);
assert.match(source,/\?'complete':'pending'/);
assert.match(source,/providerAcceptance='unavailable'/);
assert.match(source,/overallComplete:false/);
console.log(JSON.stringify({suite:'commerce-health-contract',passed:5,networkCalls:0,providerCalls:0,walletWrites:0,databaseWrites:0}));
