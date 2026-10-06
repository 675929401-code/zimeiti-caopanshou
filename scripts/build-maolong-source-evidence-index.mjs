import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {maolongCaptureLabel as captureLabel,resolveMaolongMirrorRoots} from './maolong-mirror-capture-roots.mjs';

const require=createRequire(import.meta.url);
const ts=require('typescript');
const roots=resolveMaolongMirrorRoots();
const output=path.resolve(process.env.MAOLONG_EVIDENCE_OUTPUT||'docs/带货Agent镜像融合-20260925/对标前端源码语法节点索引.json');
if(!roots.length)throw Error('No authorized mirror roots exist');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const slash=value=>value.replaceAll('\\','/');
const walk=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
const propertyName=property=>property.name&&(ts.isIdentifier(property.name)||ts.isStringLiteral(property.name))?property.name.text:'';

function inferSurface(relative){
 const normalized=slash(relative),marker='/_next/static/chunks/app/',at=normalized.indexOf(marker);
 if(at<0)return normalized.includes('/_next/static/chunks/')?'shared-client-chunk':'response-or-static-asset';
 const tail=normalized.slice(at+marker.length),segments=tail.split('/'),route=[];
 for(const segment of segments){
  if(/^\(.+\)$/u.test(segment))continue;
  if(/^(page|layout|loading|error|not-found)-/u.test(segment))break;
  route.push(segment);
 }
 return route.length?`/${route.join('/')}`:'app-shell';
}

function render(node){
 if(!node)return'';
 if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isNumericLiteral(node))return node.text;
 if(ts.isTemplateExpression(node)){let value=node.head.text;for(const span of node.templateSpans)value+=`{${render(span.expression)||'param'}}${span.literal.text}`;return value;}
 if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return render(node.left)+render(node.right);
 if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node))return render(node.expression);
 if(ts.isIdentifier(node))return`{${node.text}}`;
 if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)||ts.isConditionalExpression(node))return'{param}';
 if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='concat')return render(node.expression.expression)+node.arguments.map(render).join('');
 return'{param}';
}

function renderResolved(node,resolveIdentifier){
 if(!node)return'';
 if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isNumericLiteral(node))return node.text;
 if(ts.isTemplateExpression(node)){let value=node.head.text;for(const span of node.templateSpans)value+=`${renderResolved(span.expression,resolveIdentifier)||'{param}'}${span.literal.text}`;return value;}
 if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return renderResolved(node.left,resolveIdentifier)+renderResolved(node.right,resolveIdentifier);
 if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node))return renderResolved(node.expression,resolveIdentifier);
 if(ts.isIdentifier(node))return resolveIdentifier(node.text,node)||'{param}';
 if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)||ts.isConditionalExpression(node))return'{param}';
 if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='concat')return renderResolved(node.expression.expression,resolveIdentifier)+node.arguments.map(argument=>renderResolved(argument,resolveIdentifier)).join('');
 return'{param}';
}

function normalizeApiSignature(value){
 const at=value.indexOf('/api/v1/');
 if(at<0)return null;
 const signature=value.slice(at).replace(/\{[^}]+\}/gu,'{param}');
 return signature.length>500?signature.slice(0,500):signature;
}

function isConcreteApiSignature(signature){
 const firstSegment=signature.slice('/api/v1/'.length).split('/')[0];
 return Boolean(firstSegment)&&!firstSegment.startsWith('{param}')&&/^[a-z0-9_-]+(?:\{param\})?$/iu.test(firstSegment);
}

function sourceRange(node,sourceFile,text){
 const charStart=node.getStart(sourceFile),charEnd=node.getEnd();
 const location=sourceFile.getLineAndCharacterOfPosition(charStart);
 return {charStart,charEnd,byteStart:Buffer.byteLength(text.slice(0,charStart),'utf8'),byteEnd:Buffer.byteLength(text.slice(0,charEnd),'utf8'),line:location.line+1,column:location.character+1};
}

function methodEvidence(call,sourceFile){
 const methods=[];
 for(const argument of call.arguments){
  if(!ts.isObjectLiteralExpression(argument))continue;
  for(const property of argument.properties){
   if(ts.isPropertyAssignment(property)&&propertyName(property)==='method'){
    const value=render(property.initializer).replace(/[{}]/gu,'').toUpperCase();
    if(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/u.test(value))methods.push(value);
   }
  }
 }
 if(ts.isPropertyAccessExpression(call.expression)){
  const member=call.expression.name.text.toUpperCase();
  if(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/u.test(member))methods.push(member);
 }
 return {methods:methods.length?[...new Set(methods)]:['UNKNOWN'],methodEvidence:methods.length?'explicit-near-call':'wrapper-inference-required'};
}

function apiFamily(signature){
 const parts=signature.split('/').filter(Boolean);
 return parts[2]==='admin'?`admin.${parts[3]||'root'}`:parts[2]||'unknown';
}

const index={
 schemaVersion:'maolong.frontend-source-evidence-index/v1',
 generatedAt:new Date().toISOString(),
 roots,
 scopeBoundary:'Authorized browser-delivered client bundles, rendered page responses and sanitized read-only GET catalogs. Private server source, database implementation and queue workers are not present.',
 offsetContract:'All byte ranges are UTF-8 half-open intervals [byteStart, byteEnd). Character ranges are JavaScript UTF-16 half-open intervals. UNKNOWN methods are never assumed to be GET.',
 files:[],routes:[],tools:[],apis:[],unresolvedApis:[],skillPacks:[],statusTokens:[],errorCodes:[],
};
const routePattern=/^\/(account|admin|affiliate|agent-chat|assets|canvas|privacy|terms|register|toolbox)([/?{]|$)/u;
const mediaPattern=/\.(png|jpe?g|svg|webp|css|js|mp4|webm|woff2?)(\?|$)/iu;
const statusSet=new Set(['queued','running','recovering','settling','processing','saving','succeeded','failed','unknown','save_failed','frozen','consumed','released','needs_review']);
const errorPattern=/^[A-Z][A-Z0-9_]{4,80}$/u;
const rendererSlugs=new Set(['image-generation','video-generation','ecommerce-image-set','digital-human','depth-video-clone','hot-video-remix','reference-video-split','video-subtitle-erase','video-watermark-remove','video-quality-enhance']);

for(const root of roots){
 const captureRoot=captureLabel(root),responseRoot=path.join(root,'responses');
 const files=fs.existsSync(responseRoot)?walk(responseRoot).filter(file=>!/\.part\d+$/u.test(file)):[];
 for(const file of files){
  const buffer=fs.readFileSync(file),relative=slash(path.relative(root,file)),extension=path.extname(file).toLowerCase(),textKinds=new Set(['.js','.mjs','.cjs','.css','.html','.json','.txt','.svg','.xml','.map']),textMetricApplicable=textKinds.has(extension),text=textMetricApplicable?buffer.toString('utf8'):'',fileSha256=sha(buffer);
  const physicalLines=textMetricApplicable?text.split('\n'):[],surface=inferSurface(relative),record={captureRoot,path:relative,surface,sha256:fileSha256,bytes:buffer.length,physicalLines:physicalLines.length,textMetricApplicable,kind:extension.slice(1)||'none',singleLineMinified:false,astNodes:0,stringLiterals:0,parseDiagnostics:0,signalCounts:{routes:0,apis:0,tools:0,statuses:0,errorCodes:0},lineSignals:[]};
  if(path.extname(file).toLowerCase()!=='.js'){index.files.push(record);continue;}
 const sourceFile=ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  record.parseDiagnostics=sourceFile.parseDiagnostics?.length||0;
  record.singleLineMinified=physicalLines.length===1&&buffer.length>20_000;
  const lineStats=Array.from({length:physicalLines.length},(_,line)=>({line:line+1,byteStart:0,byteEnd:0,astNodeStarts:0,stringLiteralStarts:0,routeSignals:0,apiSignals:0,toolSignals:0,statusSignals:0,errorCodeSignals:0}));
  let cursor=0;for(let line=0;line<physicalLines.length;line++){lineStats[line].byteStart=cursor;cursor+=Buffer.byteLength(physicalLines[line],'utf8');lineStats[line].byteEnd=cursor;if(line<physicalLines.length-1)cursor+=1;}
  const emit=(collection,node,value,lineField)=>{const evidence={...value,captureRoot,file:relative,surface,fileSha256,...sourceRange(node,sourceFile,text)};collection.push(evidence);record.signalCounts[lineField]+=1;lineStats[evidence.line-1][`${lineField==='routes'?'route':lineField==='apis'?'api':lineField==='tools'?'tool':lineField==='statuses'?'status':'errorCode'}Signals`]+=1;};
  const emitApi=(node,value)=>emit(isConcreteApiSignature(value.signature)?index.apis:index.unresolvedApis,node,value,'apis');
  const scopeNodes=[];
  const collectScopes=node=>{if(ts.isFunctionLike(node))scopeNodes.push(node);ts.forEachChild(node,collectScopes);};
  collectScopes(sourceFile);
  const enclosingScopes=node=>{const values=[];for(let current=node;current;current=current.parent)if(ts.isFunctionLike(current))values.push(current);return values;};
  const bindingByScope=new Map(),wrapperByScope=new Map(),declaredNamesByScope=new Map();
  const scopedMap=(root,scope)=>{const key=scope?.getStart(sourceFile)??-1;if(!root.has(key))root.set(key,new Map());return root.get(key);};
  const lexicalLookup=(root,name,node)=>{for(const scope of enclosingScopes(node)){const value=scopedMap(root,scope).get(name);if(value)return value;if(scopedMap(declaredNamesByScope,scope).has(name))return null;}return scopedMap(root,null).get(name)||null;};
  for(const scope of scopeNodes)for(const parameter of scope.parameters)if(ts.isIdentifier(parameter.name))scopedMap(declaredNamesByScope,scope).set(parameter.name.text,true);
  const collectApiBindings=node=>{
   if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer){
    scopedMap(declaredNamesByScope,enclosingScopes(node)[0]||null).set(node.name.text,true);
    const value=render(node.initializer),signature=normalizeApiSignature(value);
    if(signature)scopedMap(bindingByScope,enclosingScopes(node)[0]||null).set(node.name.text,signature);
   }
   ts.forEachChild(node,collectApiBindings);
  };
  collectApiBindings(sourceFile);
  const resolveAt=node=>(name,identifier)=>lexicalLookup(bindingByScope,name,identifier||node);
  const collectWrappers=node=>{
   if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))){
    const outerScope=enclosingScopes(node)[0]||null;
    let wrapper=null,handled=false;
    const inspect=child=>{
     if(!handled&&ts.isCallExpression(child))for(const argument of child.arguments){
      const signature=normalizeApiSignature(renderResolved(argument,resolveAt(argument)));
      if(!signature)continue;
      const method=methodEvidence(child,sourceFile);
      if(isConcreteApiSignature(signature)&&signature.includes('{param}')&&node.initializer.parameters.length)wrapper={template:signature,...method};
      else emitApi(argument,{signature,family:apiFamily(signature),...method,symbolicResolution:'lexical-binding'});
      handled=true;
      break;
     }
     if(!handled)ts.forEachChild(child,inspect);
    };
    inspect(node.initializer.body);
    if(wrapper)scopedMap(wrapperByScope,outerScope).set(node.name.text,wrapper);
   }
   ts.forEachChild(node,collectWrappers);
  };
  collectWrappers(sourceFile);
  const collectWrapperCalls=node=>{
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.arguments[0]){
    const wrapper=lexicalLookup(wrapperByScope,node.expression.text,node);
    if(wrapper){
     const suffix=renderResolved(node.arguments[0],resolveAt(node.arguments[0]));
     const signature=normalizeApiSignature(wrapper.template.replace('{param}',suffix));
     if(signature)emitApi(node.arguments[0],{signature,family:apiFamily(signature),methods:wrapper.methods,methodEvidence:'inferred-wrapper-call',symbolicResolution:'lexical-wrapper'});
    }
   }
   ts.forEachChild(node,collectWrapperCalls);
  };
  collectWrapperCalls(sourceFile);
  const visit=node=>{
   record.astNodes+=1;const nodeLine=sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;lineStats[nodeLine].astNodeStarts+=1;
   if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)){
    record.stringLiterals+=1;lineStats[nodeLine].stringLiteralStarts+=1;
    if(statusSet.has(node.text))emit(index.statusTokens,node,{value:node.text,kind:'string-literal'},'statuses');
    if(errorPattern.test(node.text))emit(index.errorCodes,node,{value:node.text,kind:'string-literal'},'errorCodes');
   }
   if(ts.isCallExpression(node)&&!(ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='concat')){
    for(const argument of node.arguments){
     const signature=normalizeApiSignature(render(argument));if(!signature)continue;
     emitApi(argument,{signature,family:apiFamily(signature),...methodEvidence(node,sourceFile)});
    }
   }
   if(ts.isPropertyAssignment(node)&&['href','path','url'].includes(propertyName(node))){
    const route=render(node.initializer);if(routePattern.test(route)&&!route.includes('/api/')&&!mediaPattern.test(route))emit(index.routes,node.initializer,{route,evidence:'navigation-property'},'routes');
   }
   if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['push','replace','prefetch'].includes(node.expression.name.text)&&node.arguments[0]){
    const route=render(node.arguments[0]);if(routePattern.test(route)&&!route.includes('/api/')&&!mediaPattern.test(route))emit(index.routes,node.arguments[0],{route,evidence:'router-call'},'routes');
   }
   if(ts.isObjectLiteralExpression(node)){
    const properties=new Map(node.properties.map(property=>[propertyName(property),property]));
    const literal=key=>{const property=properties.get(key);return property&&ts.isPropertyAssignment(property)&&(ts.isStringLiteral(property.initializer)||ts.isNoSubstitutionTemplateLiteral(property.initializer))?property.initializer.text:null;};
    const slug=literal('slug'),name=literal('name'),status=literal('status');
    if(slug&&name&&status)emit(index.tools,node,{slug,name,status,kind:'registry'},'tools');
   }
   if(ts.isPropertyAssignment(node)&&ts.isStringLiteral(node.name)&&(ts.isFunctionExpression(node.initializer)||ts.isArrowFunction(node.initializer))&&rendererSlugs.has(node.name.text))emit(index.tools,node,{slug:node.name.text,kind:'renderer'},'tools');
   ts.forEachChild(node,visit);
  };
  visit(sourceFile);record.lineSignals=lineStats;index.files.push(record);
 }
 for(const relative of ['supplemental-readonly/catalogs/tools-image-generation-skill-packs.json','supplemental-readonly/catalogs/video-creator-skills.json']){
  const file=path.join(root,relative);if(!fs.existsSync(file))continue;
  const buffer=fs.readFileSync(file),text=buffer.toString('utf8'),fileSha256=sha(buffer),sourceFile=ts.parseJsonText(relative,text),parsed=JSON.parse(text);
  const imageById=new Map((parsed.skill_packs||[]).map(item=>[item.skill_pack_id,item])),directorById=new Map((parsed.items||[]).map(item=>[item.skill_key,item]));
  const scalar=(object,key)=>{const property=object.properties.find(value=>propertyName(value)===key);if(!property||!ts.isPropertyAssignment(property))return null;const value=property.initializer;return ts.isStringLiteral(value)?value.text:value.kind===ts.SyntaxKind.TrueKeyword?true:value.kind===ts.SyntaxKind.FalseKeyword?false:ts.isNumericLiteral(value)?Number(value.text):null;};
  const visit=node=>{if(ts.isObjectLiteralExpression(node)){const id=scalar(node,'skill_pack_id')||scalar(node,'skill_key');if(id){const source=imageById.get(id)||directorById.get(id),image=Boolean(imageById.get(id));index.skillPacks.push({id,label:source?.label||source?.name||null,catalog:image?'image':'video-director',isDefault:source?.is_default_profile??source?.is_default??false,exposed:image?source?.surfaces?.includes('toolbox')??false:source?.category?.is_exposed??false,surfaces:source?.surfaces||[],configVersion:source?.config_version||null,captureRoot,file:slash(relative),fileSha256,...sourceRange(node,sourceFile,text)});}}ts.forEachChild(node,visit);};
  visit(sourceFile);
 }
}

const wrapperMethods=new Map([
 ['/api/v1/auth/send-sms-code',['POST']],
 ['/api/v1/auth/send-email-code',['POST']],
 ['/api/v1/auth/login-or-register-by-phone',['POST']],
 ['/api/v1/auth/login-or-register-by-email-code',['POST']],
 ['/api/v1/auth/refresh',['POST']],
 ['/api/v1/me/profile',['GET']],
 ['/api/v1/canvas-shares/{param}',['GET']],
 ['/api/v1/canvas-shares/{param}/accept',['POST']],
 ['/api/v1/canvas-shares/{param}/acceptance',['GET']],
 ['/api/v1/discover/items/{param}/events',['POST']],
 ['/api/v1/model-routes/public{param}',['GET']],
 ['/api/v1/tools/{param}/skill-packs{param}',['GET']],
 ['/api/v1/video-creator/skills',['GET']],
]);
for(const api of index.apis){if(api.methods.includes('UNKNOWN')&&wrapperMethods.has(api.signature)){api.methods=wrapperMethods.get(api.signature);api.methodEvidence='inferred-wrapper';}}
for(const key of ['files','routes','tools','apis','unresolvedApis','skillPacks','statusTokens','errorCodes'])index[key].sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
const unique=(values,key)=>new Set(values.map(key)).size;
const uniqueContent=[...new Map(index.files.map(file=>[file.sha256,file])).values()];
index.summary={
 captureRoots:index.roots.length,
 files:index.files.length,
 bytes:index.files.reduce((sum,file)=>sum+file.bytes,0),
 uniqueFilePaths:unique(index.files,file=>file.path),
 uniqueFileContents:uniqueContent.length,
 uniqueContentBytes:uniqueContent.reduce((sum,file)=>sum+file.bytes,0),
 uniquePhysicalLines:uniqueContent.reduce((sum,file)=>sum+file.physicalLines,0),
 uniqueJavascriptContents:uniqueContent.filter(file=>file.kind==='js').length,
 uniqueJavascriptBytes:uniqueContent.filter(file=>file.kind==='js').reduce((sum,file)=>sum+file.bytes,0),
 uniqueSingleLineMinifiedJavascriptContents:uniqueContent.filter(file=>file.kind==='js'&&file.singleLineMinified).length,
 uniqueAstNodes:uniqueContent.reduce((sum,file)=>sum+file.astNodes,0),
 uniqueStringLiterals:uniqueContent.reduce((sum,file)=>sum+file.stringLiterals,0),
 uniqueParseDiagnostics:uniqueContent.reduce((sum,file)=>sum+file.parseDiagnostics,0),
 physicalLines:index.files.reduce((sum,file)=>sum+file.physicalLines,0),
 javascriptFiles:index.files.filter(file=>file.kind==='js').length,
 singleLineMinifiedJavascriptFiles:index.files.filter(file=>file.singleLineMinified).length,
 astNodes:index.files.reduce((sum,file)=>sum+file.astNodes,0),
 stringLiterals:index.files.reduce((sum,file)=>sum+file.stringLiterals,0),
 parseDiagnostics:index.files.reduce((sum,file)=>sum+file.parseDiagnostics,0),
 routeEvidenceNodes:index.routes.length,
 uniqueRoutes:unique(index.routes,value=>value.route),
 apiEvidenceNodes:index.apis.length,
 uniqueApiSignatures:unique(index.apis,value=>value.signature),
 apiSignaturesRequiringMethodPropagation:unique(index.apis.filter(value=>value.methods.includes('UNKNOWN')),value=>value.signature),
 unresolvedApiEvidenceNodes:index.unresolvedApis.length,
 uniqueUnresolvedApiTemplates:unique(index.unresolvedApis,value=>value.signature),
 toolEvidenceNodes:index.tools.length,
 uniqueToolSlugs:unique(index.tools,value=>`${value.slug}:${value.kind}`),
 skillPackEvidenceNodes:index.skillPacks.length,
 uniqueSkillPacks:unique(index.skillPacks,value=>`${value.catalog}:${value.id}`),
 statusEvidenceNodes:index.statusTokens.length,
 errorCodeEvidenceNodes:index.errorCodes.length,
 sourceMapFiles:index.files.filter(file=>file.path.endsWith('.map')).length,
};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(index,null,2)}\n`);
const bytes=fs.readFileSync(output);
console.log(JSON.stringify({output,bytes:bytes.length,sha256:sha(bytes),summary:index.summary},null,2));
