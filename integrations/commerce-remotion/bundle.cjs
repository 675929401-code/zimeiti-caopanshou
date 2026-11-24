const path=require('node:path');
const {bundle}=require('@remotion/bundler');
bundle({entryPoint:path.join(__dirname,'entry.jsx'),outDir:path.join(__dirname,'bundle'),publicDir:null,enableCaching:false}).catch(e=>{console.error(e.message);process.exitCode=1;});
