import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

async function main(){
  const fixtureDir=path.resolve('运行日志','Codex接管-20260914','fixtures',`commerce-identity-${Date.now()}`);
  fs.mkdirSync(fixtureDir,{recursive:true});
  process.env.COMMERCE_DATA_DIR=fixtureDir;
  const auth=await import('../src/commerce/server/auth');
  const store=await import('../src/commerce/server/store');
  const {createHash}=await import('node:crypto');
  let passed=0;
  function check(name:string,work:()=>void){work();passed+=1;console.log(`PASS ${name}`);}

  const legacy=auth.createUser('main_old_name','Fixture-password-001!','user');
  store.put('settings','main-bind-'+legacy.id,'system',{mainUserId:'main-user-stable-001',boundAt:1});
  const migrated=await auth.ensureSessionForMainUser({userId:'main-user-stable-001',username:'renamed_user',role:'user'});
  check('已有 owner 按 mainUserId 原地迁移，不移动历史数据',()=>assert.equal(migrated.id,legacy.id));
  check('普通会员会话身份固定原主站 userId',()=>assert.equal(migrated.mainUserId,'main-user-stable-001'));
  const renamedAgain=await auth.ensureSessionForMainUser({userId:'main-user-stable-001',username:'another_name',role:'user'});
  check('用户名再次变化仍复用同一 owner',()=>assert.equal(renamedAgain.id,legacy.id));

  const second=await auth.ensureSessionForMainUser({userId:'main-user-stable-002',username:'renamed_user',role:'user'});
  check('相同显示名的不同 mainUserId 不串号',()=>assert.notEqual(second.id,legacy.id));
  const forwardId='main-user-map-'+createHash('sha256').update('main-user-stable-001').digest('hex');
  check('稳定正向映射已落库',()=>assert.equal(store.get<{commerceOwnerId:string}>('settings',forwardId,'system')?.commerceOwnerId,legacy.id));

  const token=auth.createSession(migrated);
  const request=new Request('http://127.0.0.1:5000/api/commerce/session',{headers:{cookie:`${auth.COMMERCE_MAIN_SESSION_COOKIE}=${token}`}});
  check('主站 commerce session 可由自身 issuer 识别',()=>assert.equal(auth.identity(request)?.id,legacy.id));
  check('会话读回保留固定主站 userId',()=>assert.equal(auth.identity(request)?.mainUserId,'main-user-stable-001'));
  auth.revokeSession(request);
  check('服务端吊销后同一 token 立即失效',()=>assert.equal(auth.identity(request),undefined));

  store.put('sessions',createHash('sha256').update(token).digest('hex'),'system',{userId:legacy.id,name:legacy.name,role:'user',expires:Date.now()+60_000});
  check('旧 sessions bucket 不再被读取',()=>assert.equal(auth.identity(request),undefined));

  const missingIdentityToken='a'.repeat(64);
  store.put('sessions-main',createHash('sha256').update(missingIdentityToken).digest('hex'),'system',{
    userId:legacy.id,
    name:legacy.name,
    role:'user',
    issuer:'commerce-main-5000',
    expires:Date.now()+60_000,
  });
  const missingIdentityRequest=new Request('http://127.0.0.1:5000/api/commerce/session',{headers:{cookie:`${auth.COMMERCE_MAIN_SESSION_COOKIE}=${missingIdentityToken}`}});
  check('缺失 mainUserId 的旧主站会话强制重新认证',()=>assert.equal(auth.identity(missingIdentityRequest),undefined));
  check('创建会话时缺失 mainUserId 失败关闭',()=>assert.throws(()=>auth.createSession({id:legacy.id,name:legacy.name,role:'user'}),/MAIN_SESSION_IDENTITY_REQUIRED/u));

  const firstAdmin=await auth.ensureSessionForMainUser({userId:'main-admin-stable-001',username:'admin_one',role:'admin'});
  const firstAdminAgain=await auth.ensureSessionForMainUser({userId:'main-admin-stable-001',username:'admin_renamed',role:'admin'});
  const secondAdmin=await auth.ensureSessionForMainUser({userId:'main-admin-stable-002',username:'admin_two',role:'admin'});
  check('同一管理员稳定复用自己的隔离 owner',()=>assert.equal(firstAdminAgain.id,firstAdmin.id));
  check('不同管理员不共享 Commerce owner',()=>assert.notEqual(secondAdmin.id,firstAdmin.id));
  check('管理员的产品角色恒为 user',()=>assert.equal(firstAdmin.role,'user'));
  check('管理员反向绑定只记录主站角色且不免计费',()=>assert.deepEqual(
    store.get<{mainUserId:string;mainRole:string;exempt:boolean}>('settings','main-bind-'+firstAdmin.id,'system'),
    {mainUserId:'main-admin-stable-001',boundAt:store.get<{boundAt:number}>('settings','main-bind-'+firstAdmin.id,'system')?.boundAt,mainRole:'admin',exempt:false},
  ));
  const firstAdminToken=auth.createSession(firstAdmin);
  const firstAdminRequest=new Request('http://127.0.0.1:5000/api/commerce/session',{headers:{cookie:`${auth.COMMERCE_MAIN_SESSION_COOKIE}=${firstAdminToken}`}});
  check('管理员产品 cookie 读回仍是 user 角色',()=>assert.equal(auth.identity(firstAdminRequest)?.role,'user'));

  const legacyAdminToken='b'.repeat(64);
  store.put('sessions-main',createHash('sha256').update(legacyAdminToken).digest('hex'),'system',{
    userId:'legacy-local-operator',
    mainUserId:'main-admin-stable-001',
    name:'本机工作室',
    role:'admin',
    issuer:'commerce-main-5000',
    expires:Date.now()+60_000,
  });
  const legacyAdminRequest=new Request('http://127.0.0.1:5000/api/commerce/session',{headers:{cookie:`${auth.COMMERCE_MAIN_SESSION_COOKIE}=${legacyAdminToken}`}});
  check('历史管理员 Commerce cookie 强制失效',()=>assert.equal(auth.identity(legacyAdminRequest),undefined));

  const savedDir=process.env.COMMERCE_DATA_DIR;
  const savedNodeEnv=process.env.NODE_ENV;
  const mutableEnv=process.env as Record<string,string|undefined>;
  mutableEnv.NODE_ENV='production';
  delete mutableEnv.COMMERCE_DATA_DIR;
  check('生产环境缺少 COMMERCE_DATA_DIR 时失败关闭',()=>assert.throws(()=>store.runtimeDir(),/COMMERCE_DATA_DIR_REQUIRED/u));
  mutableEnv.COMMERCE_DATA_DIR='relative-commerce-runtime';
  check('相对持久目录被拒绝',()=>assert.throws(()=>store.runtimeDir(),/COMMERCE_DATA_DIR_MUST_BE_ABSOLUTE/u));
  mutableEnv.COMMERCE_DATA_DIR=savedDir;
  if(savedNodeEnv===undefined)delete mutableEnv.NODE_ENV;else mutableEnv.NODE_ENV=savedNodeEnv;

  const result={passed,failed:0,networkCalls:0,paidCalls:0,fixtureDir,completedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(fixtureDir,'结果.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
