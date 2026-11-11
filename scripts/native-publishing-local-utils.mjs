import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const nativeRoot=path.join(projectRoot,'integrations/aitoearn-native-app');
export const nativeBasePath='/publish-center/native';
export const nativePort=5041;
export const nativeIdentityPath=path.join(nativeRoot,'public/native-build-identity.json');
export const nativeStatePath=path.join(projectRoot,'.runtime/native-publishing/process.json');
export async function assertNativePortFree(){await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(new Error('NATIVE_PORT_OCCUPIED_REQUIRES_OWNER_CHECK')));probe.listen(nativePort,'127.0.0.1',()=>probe.close(resolve));});}
export async function nativeSourceFingerprint(){
  const files=[];
  async function walk(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(['node_modules','.next','.git'].includes(entry.name))continue;const file=path.join(directory,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&!/\.tsbuildinfo$/.test(entry.name)&&entry.name!=='next-env.d.ts'&&file!==nativeIdentityPath)files.push(file);}}
  await walk(nativeRoot);
  const hostContracts=['publishing-contract.ts','publishing-native.ts','publishing-plugin.ts','publishing-v2-contract.ts','publishing-v3-contract.ts','publishing-cash-contract.ts','native-operations-contract.ts','native-agent-contract.ts','publishing-authorization-contract.ts','user-profile-avatar.ts','native-ai-contract.ts','native-main-media-contract.ts','native-main-media-bridge-contract.ts'];
  const allowedAliases=new Set(hostContracts.map(name=>name.replace(/\.ts$/u,'')));
  for(const file of files){if(!/\.[cm]?tsx?$/u.test(file))continue;const source=await fs.readFile(file,'utf8');for(const match of source.matchAll(/['"]@host-publishing\/([^'"]+)['"]/gu)){if(!allowedAliases.has(match[1]))throw new Error('NATIVE_HOST_IMPORT_NOT_FINGERPRINTED');}}
  for(const name of hostContracts)files.push(path.join(projectRoot,'src/lib',name));
  files.sort((a,b)=>a.localeCompare(b,'en'));
  const digest=createHash('sha256');let bytes=0;
  for(const file of files){const data=await fs.readFile(file);digest.update(path.relative(projectRoot,file).replaceAll('\\','/'));digest.update('\0');digest.update(data);digest.update('\0');bytes+=data.length;}
  return {digest:digest.digest('hex'),files:files.length,bytes};
}
export function nativeEnvironment(){
  const names=['SystemRoot','WINDIR','SystemDrive','ComSpec','PATH','Path','PATHEXT','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'];
  const environment=Object.fromEntries(names.filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
  return {...environment,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',NODE_OPTIONS:'--max-old-space-size=6144',NEXT_PUBLIC_API_URL:'/api/native-operations',NEXT_PUBLIC_NATIVE_HOST_PATH:'/api/native-operations',NEXT_PUBLIC_APP_BASE_PATH:nativeBasePath,NEXT_PUBLIC_IS_CHINA:'true',HOSTNAME:'127.0.0.1',PORT:String(nativePort)};
}
