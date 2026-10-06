#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const before=process.argv.find(value=>value.startsWith('--before='))?.slice(9);
assert.ok(before,'Pass --before=<segmenter snapshot>');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function inspect(file){
 const source=fs.readFileSync(file,'utf8');const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let authCallback;let readinessEffect;let disabled;
 function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='runAuthCheck')authCallback=node.initializer.arguments[0].getText(tree);
  if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useEffect'&&node.arguments[0]?.getText(tree).includes('auth.isAuthenticated && auth.user?.id && auth.token'))readinessEffect=node.arguments[0].getText(tree);
  if(ts.isJsxOpeningElement(node)&&node.tagName.getText(tree)==='button'){
   const props=node.attributes.properties;
   if(props.some(prop=>prop.name?.getText(tree)==='onClick'&&prop.initializer?.expression?.getText(tree)==='handleSegment'))disabled=props.find(prop=>prop.name?.getText(tree)==='disabled').initializer.expression.getText(tree);
  }
  ts.forEachChild(node,visit);
 }
 visit(tree);return{authCallback,readinessEffect,disabled};
}
const current=inspect('src/app/segmenter/page.tsx');const old=inspect(before);assert.ok(current.readinessEffect);assert.equal(old.readinessEffect,undefined);
const authCallback=inspect('src/contexts/app-context.tsx').authCallback;assert.ok(authCallback);
let enterCredits;let finishCredits;let authCompleted=false;
const creditsEntered=new Promise(resolve=>{enterCredits=resolve;});const credits=new Promise(resolve=>{finishCredits=resolve;});
const stored=new Map([['AUTH_TOKEN','fixture-token']]);
const context=vm.createContext({
 auth:{isAuthenticated:false,user:null,token:null},authRestoring:true,inputReady:true,inputText:'fixture text',segmenting:false,
 STORAGE_KEYS:{AUTH_TOKEN:'AUTH_TOKEN',AUTH_USER:'AUTH_USER'},safeGet:key=>stored.get(key)||null,safeSet:(key,value)=>stored.set(key,value),safeRemove:key=>stored.delete(key),
 getClientBootstrapAuthMe:async()=>new Response(JSON.stringify({user:{id:'fixture-user'}}),{status:200}),
 dispatch:action=>{if(action.type==='SET_AUTH')context.auth={...action.payload,isAuthenticated:Boolean(action.payload.user&&action.payload.token)};},
 fetch:async url=>{assert.ok(url.startsWith('/api/credits?'));enterCredits();return credits;},
 setAuthRestoring:value=>{context.authRestoring=value;},
 clearStoredAuthSession(){},invalidateClientBootstrapAuthMe(){},
});
vm.runInContext(compile(`globalThis.runAuth=${authCallback};`),context);
const pending=context.runAuth(false).then(()=>{authCompleted=true;});await creditsEntered;
assert.equal(authCompleted,false);assert.equal(context.auth.isAuthenticated,true);assert.equal(context.auth.user.id,'fixture-user');
assert.equal(vm.runInContext(old.disabled,context),true,'Old form stays disabled even after SET_AUTH');
vm.runInContext(compile(`(${current.readinessEffect})();`),context);
assert.equal(authCompleted,false);assert.equal(context.authRestoring,false);assert.equal(vm.runInContext(current.disabled,context),false);
for(const auth of [
 {isAuthenticated:false,user:{id:'fixture-user'},token:'fixture-token'},
 {isAuthenticated:true,user:null,token:'fixture-token'},
 {isAuthenticated:true,user:{id:'fixture-user'},token:null},
]){
 context.auth=auth;context.authRestoring=true;vm.runInContext(compile(`(${current.readinessEffect})();`),context);assert.equal(context.authRestoring,true);
}
context.auth={isAuthenticated:true,user:{id:'fixture-user'},token:'fixture-token'};context.authRestoring=false;
finishCredits(new Response(JSON.stringify({credits:1}),{status:200}));await pending;assert.equal(authCompleted,true);assert.equal(context.authRestoring,false);
const result={pass:true,scenarios:6,cases:['actual auth callback publishes complete identity before pending credits resolves','old submit guard remains disabled while credits hangs','new page effect unlocks complete identity without waiting for credits','isAuthenticated=false does not unlock','missing user or token does not unlock','late balance completion does not relock'],realAuthRequests:0,generationRequests:0,databaseWrites:0};
fs.writeFileSync('.codex-evidence/persisted-state-hydration-20260902/auth-balance-wait-fixture.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
