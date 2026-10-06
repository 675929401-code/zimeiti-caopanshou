import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
// Node 24 built-in SQLite, with transactions and WAL; no business database sharing.
type Statement = { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, unknown>|undefined; all(...args: unknown[]): Record<string, unknown>[] };
type Database = { exec(sql:string):void; prepare(sql:string):Statement };
const globalStore=globalThis as unknown as {commerceDatabase?:Database};
export const runtimeDir=()=>{
 const configured=process.env.COMMERCE_DATA_DIR?.trim();
 if(process.env.NODE_ENV==='production'&&!configured)throw Error('COMMERCE_DATA_DIR_REQUIRED_IN_PRODUCTION');
 if(configured&&!path.isAbsolute(configured))throw Error('COMMERCE_DATA_DIR_MUST_BE_ABSOLUTE');
 return path.resolve(configured||path.join(process.cwd(),'runtime'));
};
export function db():Database {
 if(!globalStore.commerceDatabase){fs.mkdirSync(runtimeDir(),{recursive:true,mode:0o700});const database:Database=new DatabaseSync(path.join(runtimeDir(),'commerce.sqlite'));database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,value TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(bucket,id));
 CREATE INDEX IF NOT EXISTS records_owner ON records(bucket,owner,updated);
 CREATE TABLE IF NOT EXISTS requests (request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL);
 `);globalStore.commerceDatabase=database;}return globalStore.commerceDatabase;
}
export function put(bucket:string,id:string,owner:string,value:unknown){db().prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE records.owner=excluded.owner').run(bucket,id,owner,JSON.stringify(value),Date.now());}
export function get<T>(bucket:string,id:string,owner:string):T|undefined{const row=db().prepare('SELECT value FROM records WHERE bucket=? AND id=? AND owner=?').get(bucket,id,owner);return row?JSON.parse(String(row.value)):undefined;}
export function list<T>(bucket:string,owner:string):T[]{return db().prepare('SELECT value FROM records WHERE bucket=? AND owner=? ORDER BY updated DESC LIMIT 500').all(bucket,owner).map(row=>JSON.parse(String(row.value)));}
export function remove(bucket:string,id:string,owner:string){db().prepare('DELETE FROM records WHERE bucket=? AND id=? AND owner=?').run(bucket,id,owner);}
export function claim(key:string,fingerprint:string,id:string){try{db().prepare('INSERT INTO requests VALUES(?,?,?)').run(key,fingerprint,id);return {created:true,id};}catch{const row=db().prepare('SELECT * FROM requests WHERE request_key=?').get(key);if(!row||row.fingerprint!==fingerprint)throw Error('同一个请求号对应了不同内容，请重新确认任务。');return {created:false,id:String(row.job_id)};}}
// The database transition, rather than a process-local Set, owns dispatch.
export function claimQueuedJob<T>(id:string,owner:string):T|undefined{const now=Date.now();const row=db().prepare("UPDATE records SET value=json_set(value,'$.status','running','$.startedAt',?,'$.updatedAt',?),updated=? WHERE bucket='jobs' AND id=? AND owner=? AND json_extract(value,'$.status')='queued' RETURNING value").get(now,now,now,id,owner);return row?JSON.parse(String(row.value)):undefined;}

// Use only synchronous callbacks: the claim and job insertion commit together.
export function transaction<T>(work:()=>T):T{const database=db();database.exec('BEGIN IMMEDIATE');try{const result=work();database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}}

export type DurableRecordLease={
 bucket:string;
 key:string;
 owner:string;
 holder:string;
 token:number;
 claimedAt:number;
 expiresAt:number;
};

export function claimRecordLease(bucket:string,key:string,owner:string,holder:string,now:number,durationMs:number){
 return transaction(()=>{
  const previous=get<DurableRecordLease>(bucket,key,owner);
  if(previous&&previous.expiresAt>now)return null;
  const lease:DurableRecordLease={bucket,key,owner,holder,token:Number(previous?.token||0)+1,claimedAt:now,expiresAt:now+durationMs};
  put(bucket,key,owner,lease);
  return lease;
 });
}

export function renewRecordLease(lease:DurableRecordLease,now:number,durationMs:number){
 return transaction(()=>{
  const current=get<DurableRecordLease>(lease.bucket,lease.key,lease.owner);
  if(!current||current.holder!==lease.holder||current.token!==lease.token||current.expiresAt<=now)return false;
  current.expiresAt=now+durationMs;
  put(current.bucket,current.key,current.owner,current);
  lease.expiresAt=current.expiresAt;
  return true;
 });
}

export function recordLeaseIsCurrent(lease:DurableRecordLease,now=Date.now()){
 const current=get<DurableRecordLease>(lease.bucket,lease.key,lease.owner);
 return Boolean(current&&current.holder===lease.holder&&current.token===lease.token&&current.expiresAt>now);
}

export function releaseRecordLease(lease:DurableRecordLease){
 return transaction(()=>{
  const current=get<DurableRecordLease>(lease.bucket,lease.key,lease.owner);
  if(!current||current.holder!==lease.holder||current.token!==lease.token)return false;
  current.expiresAt=0;
  put(current.bucket,current.key,current.owner,current);
  return true;
 });
}
