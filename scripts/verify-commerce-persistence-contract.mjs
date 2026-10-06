import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
let passed=0;
const check=(name,work)=>{work();passed+=1;console.log(`PASS ${name}`);};

const pm2=read('deploy/pm2/ecosystem.vnext.config.cjs');
check('PM2 固定 commerce 目录在 shared runtime',()=>assert.match(pm2,/commerceDataDir[\s\S]*appRuntimeDir,\s*["']commerce-agent["']/u));
check('PM2 三类进程均显式传递 COMMERCE_DATA_DIR',()=>assert.equal(pm2.match(/COMMERCE_DATA_DIR:\s*commerceDataDir/gu)?.length,3));
check('PM2 三类进程均显式传递只读发现镜像目录',()=>assert.equal(pm2.match(/COMMERCE_DISCOVERY_CATALOG:\s*commerceDiscoveryCatalog/gu)?.length,3));
check('PM2 三类进程均显式传递固定网关密钥文件',()=>{
  assert.match(pm2,/commerceGatewayKeyFile[\s\S]*commerceDataDir,\s*["']main-gateway\.key["']/u);
  assert.equal(pm2.match(/COMMERCE_GATEWAY_KEY_FILE:\s*commerceGatewayKeyFile/gu)?.length,3);
});

const deploy=read('scripts/deploy-artifact-vnext.sh');
check('候选与正式进程共享固定目录',()=>{
  assert.match(deploy,/COMMERCE_DATA_DIR="\$APP_RUNTIME_DIR\/commerce-agent"/u);
  assert.match(deploy,/COMMERCE_DISCOVERY_CATALOG="\$COMMERCE_DISCOVERY_ROOT\/catalog\.json"/u);
  assert.match(deploy,/COMMERCE_GATEWAY_KEY_FILE="\$COMMERCE_DATA_DIR\/main-gateway\.key"/u);
  assert.ok((deploy.match(/COMMERCE_DATA_DIR="\$COMMERCE_DATA_DIR"/gu)||[]).length>=2);
  assert.ok((deploy.match(/COMMERCE_GATEWAY_KEY_FILE="\$COMMERCE_GATEWAY_KEY_FILE"/gu)||[]).length>=2);
  assert.match(deploy,/export RELEASE_ROOT APP_DATA_DIR APP_RUNTIME_DIR COMMERCE_DATA_DIR COMMERCE_DISCOVERY_CATALOG COMMERCE_GATEWAY_KEY_FILE IDEMPOTENCY_DIR/u);
});
check('发布前要求预置非符号链接持久目录',()=>assert.match(deploy,/assert_regular_directory "\$COMMERCE_DATA_DIR" "shared commerce data"/u));
check('发布前要求预置只读发现目录与媒体目录',()=>{
  assert.match(deploy,/assert_regular_directory "\$COMMERCE_DISCOVERY_ROOT" "shared commerce discovery mirror"/u);
  assert.match(deploy,/assert_regular_directory "\$COMMERCE_DISCOVERY_ROOT\/media" "shared commerce discovery media"/u);
});
check('commerce 目录进入可读写遍历门禁',()=>assert.match(deploy,/"\$APP_DATA_DIR" "\$APP_RUNTIME_DIR" "\$COMMERCE_DATA_DIR" "\$IDEMPOTENCY_DIR"/u));
check('发布前密钥文件权限和长度失败关闭',()=>{
  assert.match(deploy,/commerce gateway key must be a readable regular non-symlink file/u);
  assert.match(deploy,/commerce gateway key must be owned by root/u);
  assert.match(deploy,/commerce_gateway_key_mode\s*&\s*8#077/u);
  assert.match(deploy,/value\.length<40/u);
});

for(const file of ['src/app/api/commerce-billing-gateway/route.ts','src/app/api/commerce-model-gateway/route.ts']){
  const source=read(file);
  check(`${file} 默认绑定 commerce 持久目录下同一密钥`,()=>{
    assert.match(source,/path\.join\(runtimeDir\(\),\s*['"]main-gateway\.key['"]\)/u);
    assert.doesNotMatch(source,/模型共享凭据/u);
  });
}

for(const file of ['src/commerce/server/store.ts','../../带货Agent/src/server/store.ts']){
  const source=read(file);
  check(`${file} 生产缺目录时失败关闭`,()=>assert.match(source,/COMMERCE_DATA_DIR_REQUIRED_IN_PRODUCTION/u));
  check(`${file} 拒绝相对目录`,()=>assert.match(source,/COMMERCE_DATA_DIR_MUST_BE_ABSOLUTE/u));
}

const policy=JSON.parse(read('deploy/policies/release-policy.json'));
check('发布策略声明 commerce 持久挂载',()=>assert.ok(policy.runtime.requiredServerMounts.includes('shared/runtime/commerce-agent')));
check('发布策略声明 commerce 发现镜像挂载',()=>assert.ok(policy.runtime.requiredServerMounts.includes('shared/runtime/commerce-discovery')));
check('本地主站与独立 A 端不再共写 SQLite',()=>{
  const localStart=read('scripts/run-start.mjs');
  assert.match(localStart,/path\.win32\.join\(LOCAL_PREVIEW_DATA_ROOT,\s*["']preview-runtime["'],\s*["']commerce-agent["']\)/u);
  assert.match(localStart,/path\.win32\.join\(LOCAL_PREVIEW_DATA_ROOT,\s*["']preview-runtime["'],\s*["']commerce-discovery["'],\s*["']catalog\.json["']\)/u);
  assert.doesNotMatch(localStart,/带货Agent[\\/]runtime/u);
  assert.match(localStart,/COMMERCE_GATEWAY_KEY_FILE/u);
  const binder=read('../../带货Agent/scripts/bind-main-models.mjs');
  assert.match(binder,/LOCAL_PREVIEW_DATA_ROOT/u);
  assert.match(binder,/GATEWAY_KEY_MISMATCH_REQUIRES_MANUAL_RECONCILIATION/u);
  assert.doesNotMatch(binder,/模型共享凭据/u);
});
check('生产环境模板声明 commerce 持久目录',()=>{
  assert.match(read('deploy/environments/production.env.example'),/^COMMERCE_DATA_DIR=\/srv\/zimeiti-caopanshou\/shared\/runtime\/commerce-agent$/mu);
  assert.match(read('.env.example'),/^COMMERCE_DATA_DIR=\/srv\/zimeiti-caopanshou\/shared\/runtime\/commerce-agent$/mu);
  assert.match(read('deploy/environments/production.env.example'),/^COMMERCE_DISCOVERY_CATALOG=\/srv\/zimeiti-caopanshou\/shared\/runtime\/commerce-discovery\/catalog\.json$/mu);
  assert.match(read('.env.example'),/^COMMERCE_DISCOVERY_CATALOG=\/srv\/zimeiti-caopanshou\/shared\/runtime\/commerce-discovery\/catalog\.json$/mu);
  assert.match(read('deploy/environments/production.env.example'),/^COMMERCE_GATEWAY_KEY_FILE=\/srv\/zimeiti-caopanshou\/shared\/runtime\/commerce-agent\/main-gateway\.key$/mu);
  assert.match(read('.env.example'),/^COMMERCE_GATEWAY_KEY_FILE=\/srv\/zimeiti-caopanshou\/shared\/runtime\/commerce-agent\/main-gateway\.key$/mu);
});

console.log(JSON.stringify({passed,failed:0,networkCalls:0,paidCalls:0,productionPath:'/srv/zimeiti-caopanshou/shared/runtime/commerce-agent'}));
