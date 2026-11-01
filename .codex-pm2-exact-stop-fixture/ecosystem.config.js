'use strict';
const path=require('node:path');
const script=path.join(__dirname,'fake-worker.cjs');
const apps=Array.from({length:18},(_,i)=>({name:'fixture-filler-'+i,script,exec_mode:'fork',autorestart:false,shutdown_with_message:true,kill_timeout:5000}));
apps.push({name:'agent-hub-media-worker',script,instances:2,exec_mode:'fork',autorestart:false,shutdown_with_message:true,kill_timeout:5000});
module.exports={apps};
