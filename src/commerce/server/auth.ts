import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {db,get,put,remove,transaction} from './store';
type CommerceOwnerIdentity={id:string;name:string;role:'admin'|'user'};
export type Identity=CommerceOwnerIdentity & {mainUserId:string};
type User=CommerceOwnerIdentity & {salt:string;hash:string};
export const COMMERCE_MAIN_SESSION_COOKIE='commerce_session';
const COMMERCE_MAIN_SESSION_ISSUER='commerce-main-5000';
const COMMERCE_MAIN_SESSION_BUCKET='sessions-main';
type MainBinding={mainUserId:string;boundAt:number;mainRole?:'admin'|'user';exempt?:boolean};
type ForwardMainBinding={mainUserId:string;commerceOwnerId:string;boundAt:number};
export function hashPassword(password:string,salt:string){return scryptSync(password,salt,64).toString('hex');}
export function getUser(name:string){return get<User>('users',name.toLowerCase(),'system');}
export function createUser(name:string,password:string,role:'admin'|'user'='user'){if(!/^[\p{L}\p{N}_@.-]{2,50}$/u.test(name)||password.length<10||password.length>200)throw Error('账号需 2–50 个字符，密码至少 10 个字符。');if(getUser(name))throw Error('账号已存在');const salt=randomBytes(16).toString('hex');const value={id:crypto.randomUUID(),name,role,salt,hash:hashPassword(password,salt)};put('users',name.toLowerCase(),'system',value);return value;}
export function passwordMatches(user:User,password:string){const hash=hashPassword(password,user.salt);return timingSafeEqual(Buffer.from(hash),Buffer.from(user.hash));}
export function createSession(user:CommerceOwnerIdentity & {mainUserId?:string}){if(!user.mainUserId?.trim())throw Error('MAIN_SESSION_IDENTITY_REQUIRED');if(user.role!=='user')throw Error('COMMERCE_PRODUCT_ROLE_INVALID');const token=randomBytes(32).toString('hex');put(COMMERCE_MAIN_SESSION_BUCKET,createHash('sha256').update(token).digest('hex'),'system',{userId:user.id,mainUserId:user.mainUserId,name:user.name,role:'user',issuer:COMMERCE_MAIN_SESSION_ISSUER,expires:Date.now()+7*86400000});return token;}
function sessionToken(request:Request){return (request.headers.get('cookie')||'').match(new RegExp(`(?:^|;\\s*)${COMMERCE_MAIN_SESSION_COOKIE}=([a-f0-9]{64})(?:;|$)`))?.[1];}
export function identity(request:Request):Identity|undefined{const token=sessionToken(request);if(!token)return;const session=get<{userId:string;mainUserId?:string;name:string;role:'admin'|'user';issuer?:string;expires:number}>(COMMERCE_MAIN_SESSION_BUCKET,createHash('sha256').update(token).digest('hex'),'system');if(!session||session.issuer!==COMMERCE_MAIN_SESSION_ISSUER||session.expires<Date.now()||!session.mainUserId?.trim()||session.role!=='user')return;return {id:session.userId,mainUserId:session.mainUserId,name:session.name,role:'user'};}
export function revokeSession(request:Request){const token=sessionToken(request);if(token)remove(COMMERCE_MAIN_SESSION_BUCKET,createHash('sha256').update(token).digest('hex'),'system');}
export function requireIdentity(request:Request,admin=false){const user=identity(request);if(!user)throw Error('UNAUTHORIZED');if(admin&&user.role!=='admin')throw Error('FORBIDDEN');return user;}
/**
 * 主站用户 → 带货身份桥接（第二阶段扣费前置）。
 * 所有主站账号：按 mainUserId 创建/复用唯一产品身份，产品角色恒为 user。
 * 主站角色仅写入反向绑定用于重新核验，绝不转化为 Commerce 管理权限或计费豁免。
 * 旧版共享 local-operator 不满足员工隔离要求，迁移时不会被复用。
 */
function forwardKey(mainUserId:string){return 'main-user-map-'+createHash('sha256').update(mainUserId).digest('hex');}
function storedUserById(ownerId:string){const row=db().prepare("SELECT value FROM records WHERE bucket='users' AND json_extract(value,'$.id')=?").get(ownerId);return row?JSON.parse(String(row.value)) as User:undefined;}
function existingBoundUser(mainUserId:string){
  const forward=get<ForwardMainBinding>('settings',forwardKey(mainUserId),'system');
  if(forward){
    if(forward.mainUserId!==mainUserId)throw Error('主站身份映射校验失败，请联系管理员处理。');
    const user=storedUserById(forward.commerceOwnerId);
    const reverse=get<MainBinding>('settings','main-bind-'+forward.commerceOwnerId,'system');
    if(!user||reverse?.mainUserId!==mainUserId)throw Error('主站身份映射不完整，请联系管理员处理。');
    if(user.role!=='user'||reverse.exempt===true)return;
    return user;
  }
  const matches=db().prepare("SELECT id,value FROM records WHERE bucket='settings' AND owner='system' AND id LIKE 'main-bind-%'").all()
    .map(row=>({id:String(row.id),value:JSON.parse(String(row.value)) as MainBinding}))
    .filter(row=>row.value.mainUserId===mainUserId&&row.value.exempt!==true)
    .map(row=>({row,user:storedUserById(row.id.slice('main-bind-'.length))}))
    .filter(candidate=>candidate.user?.role==='user');
  if(matches.length>1)throw Error('检测到重复的主站身份映射，请联系管理员处理。');
  return matches[0]?.user;
}
export async function ensureSessionForMainUser(payload:{userId:string;username:string;role:string}){
  const mainUserId=payload.userId;
  const mainRole=payload.role==='admin'?'admin' as const:'user' as const;
  return transaction(()=>{
    let user=existingBoundUser(mainUserId);
    if(!user){
      const mappedName=('main_'+createHash('sha256').update(mainUserId).digest('hex').slice(0,40)).toLowerCase();
      user=getUser(mappedName);
      if(user){
        const bound=get<MainBinding>('settings','main-bind-'+user.id,'system');
        if(bound?.mainUserId!==mainUserId)throw Error('主站身份映射发生冲突，请联系管理员处理。');
      }else user=createUser(mappedName,'Main-'+crypto.randomUUID().slice(0,16)+'!a','user');
    }
    const now=Date.now();
    const reverse=get<MainBinding>('settings','main-bind-'+user.id,'system');
    if(reverse&&reverse.mainUserId!==mainUserId)throw Error('带货工作区已绑定其他主站账号，拒绝覆盖。');
    put('settings','main-bind-'+user.id,'system',{mainUserId,boundAt:reverse?.boundAt||now,mainRole,exempt:false});
    put('settings',forwardKey(mainUserId),'system',{mainUserId,commerceOwnerId:user.id,boundAt:now});
    return {id:user.id,mainUserId,name:user.name,role:'user' as const};
  });
}
export function sameOrigin(request:Request){
  const origin=request.headers.get('origin');
  const host=request.headers.get('host')||new URL(request.url).host;
  const selfOrigin=`${new URL(request.url).protocol}//${host}`;
  const configured=process.env.COMMERCE_PUBLIC_ORIGIN||'';
  // 共宿主后默认同源（主站自生 origin 恒可）；配置 COMMERCE_PUBLIC_ORIGIN 仅用于额外放行历史 5048 地址。
  const permitted=new Set([selfOrigin,configured,...(configured==='http://127.0.0.1:5048'?['http://localhost:5048','http://127.0.0.1:5048']:[])].filter(Boolean));
  if(origin&&(!permitted.has(origin)||new URL(origin).host!==host))throw Error('FORBIDDEN');
  if(request.headers.get('sec-fetch-site')==='cross-site')throw Error('FORBIDDEN');
}
