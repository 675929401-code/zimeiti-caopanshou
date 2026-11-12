import {spawn} from 'node:child_process';
const {HTTP_PROXY,HTTPS_PROXY,http_proxy,https_proxy,ALL_PROXY,all_proxy,...clean}=process.env;
const env={...clean,PORT:'5000',HOSTNAME:'127.0.0.1',NO_PROXY:'*',no_proxy:'*'};
const child=spawn(process.execPath,['.next/standalone/server.js'],{env,cwd:'.next/standalone',stdio:'inherit',detached:true});
child.unref();
console.log('started pid:',child.pid);
process.exit(0);
