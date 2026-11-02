'use strict';
const root='/tmp/native-hook-fixture/web/releases/old/web';
const common={script:root+'/server.js',cwd:root,exec_mode:'fork',autorestart:false,shutdown_with_message:true,kill_timeout:process.env.FIXTURE_DELAY_EXIT==='1'?2000:35000};
const apps=Array.from({length:18},(_,i)=>({...common,name:'fixture-filler-'+i}));
apps.push({...common,name:'agent-hub-media-worker',instances:2,increment_var:'PORT',env:{PORT:5102,RELEASE_ID:'candidate-fixture-r30',DEPLOY_COMMIT_SHA:'a'.repeat(40),EXPECTED_BUILD_ID:'fixture-build',RELEASE_SOURCE_VERSION:'R-fixture',RELEASE_BUILD_OUTPUT_DIGEST:'b'.repeat(64),ASSET_DIGEST:'c'.repeat(64),ASSET_MANIFEST_SHA256:'d'.repeat(64),MEDIA_QUEUE_WORKER_PROCESS:'1',DIGITAL_VIDEO_QUEUE_WORKER:'1',DIGITAL_HUMAN_LONG_WORKER:'1',FIXTURE_NO_DRAIN:process.env.FIXTURE_NO_DRAIN||'0',FIXTURE_DELAY_EXIT:process.env.FIXTURE_DELAY_EXIT||'0'}});
module.exports={apps};
