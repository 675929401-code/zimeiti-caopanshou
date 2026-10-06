import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
const runtime=JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json','utf8'));
if(!runtime.localOnly||runtime.ownerConnection.host!=='127.0.0.1'||runtime.ownerConnection.port!==54322||runtime.ownerConnection.database!=='zimeiti_local')throw new Error('LOCAL_ONLY');
const db=new pg.Client(runtime.ownerConnection);await db.connect();
try{
const key=process.argv.includes('--fixed')?'general-script-f38d98ce-c79d-425f-8043-e186e39e8ec3':'general-script-cdfab09f-4cb2-4e6b-bfdb-427cf4325048';
const {rows}=await db.query('select state,http_status,response_body,error_code,attempt_no from public.llm_request_attempts where client_request_id=$1',[key]);
if(rows.length!==1)throw new Error('EXPECTED_ONE_OWN_SYNTHETIC_ATTEMPT');
const row=rows[0],payload=JSON.parse(row.response_body||'{}');
const text=payload.output_text||payload.choices?.[0]?.message?.content||payload.content||'';
let result;try{result=JSON.parse(text);}catch{result={unparsed:true,textLength:text.length};}
await writeFile(`.codex-evidence/manju-production-e2e-20260902/script-attempt-output${process.argv.includes('--fixed')?'-fixed':''}.json`,JSON.stringify({state:row.state,httpStatus:row.http_status,attemptNo:row.attempt_no,errorCode:row.error_code,payloadKeys:Object.keys(payload),result},null,2));
console.log(JSON.stringify({state:row.state,httpStatus:row.http_status,attemptNo:row.attempt_no,errorCode:row.error_code,payloadKeys:Object.keys(payload),result}));
}finally{await db.end();}
