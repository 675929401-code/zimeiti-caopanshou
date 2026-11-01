'use strict';
const http=require('node:http');
const port=Number(process.env.PORT||0);
if(port){
 http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({releaseId:process.env.RELEASE_ID,deployCommitSha:process.env.DEPLOY_COMMIT_SHA,buildId:process.env.EXPECTED_BUILD_ID,sourceVersion:process.env.RELEASE_SOURCE_VERSION}));}).listen(port,'127.0.0.1');
}
process.on('message',(message)=>{if(message==='shutdown'){if(process.env.FIXTURE_DELAY_EXIT==='1'){setTimeout(()=>process.exit(0),5000);return;}if(process.env.FIXTURE_NO_DRAIN!=='1')process.stdout.write("[MediaQueueWorker] stopped { reason: 'pm2-shutdown', drained: true }\n",()=>process.exit(0));else process.exit(0);}});
setInterval(()=>{},1000);
