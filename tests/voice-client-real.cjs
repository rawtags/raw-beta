'use strict';
// Owned hidden Electron test. Generated PCM only through a track generator;
// capture permissions are denied and ICE is loopback-only. No owner microphone.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
if(!process.versions.electron){
 const {spawn}=require('node:child_process'),binary=path.resolve(__dirname,'../../node_modules/electron/dist/electron.exe');
 if(!fs.existsSync(binary))throw Error('The reviewed local Electron runtime is missing. No download is attempted.');
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(binary,[__filename],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));child.once('exit',(code,signal)=>{if(code!==0)console.error(JSON.stringify({test:'synthetic-local-voice',ok:false,childExitCode:code,signal}));process.exit(code===0?0:1);});child.once('error',error=>{console.error(error.message);process.exit(1);});
}else{
 const {app,BrowserWindow,ipcMain}=require('electron'),http=require('node:http');
 const qaData=fs.mkdtempSync(path.join(os.tmpdir(),'raw-synthetic-voice-'));app.setPath('userData',qaData);
 app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
 let server,window,done=false;
 const finish=(ok,value)=>{if(done)return;done=true;clearTimeout(deadline);const result={test:'synthetic-local-voice',ok,electron:process.versions.electron,chromium:process.versions.chrome,...value};const output=path.join(__dirname,'../outputs');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'voice-client-real-result.json'),JSON.stringify(result,null,2));fs.appendFileSync(path.join(output,'voice-client-real-attempts.jsonl'),JSON.stringify(result)+'\n');console.log(JSON.stringify(result));server?.close();window?.destroy();app.exit(ok?0:1);};
 const deadline=setTimeout(()=>finish(false,{error:'Synthetic voice test exceeded 55 seconds.'}),55000);
 app.whenReady().then(async()=>{
  const ts=require('../node_modules/typescript'),client=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../browser/voice-client.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  server=http.createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.url==='/voice-client.js'){res.setHeader('Content-Type','text/javascript');res.end(client);}else if(req.url==='/harness.mjs'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(__dirname,'voice-client-real-page.mjs')));}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><title>Raw synthetic voice QA</title><body>Synthetic audio QA only<script type="module" src="/harness.mjs"></script></body></html>');}else{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  window=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'voice-client-real-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,answer)=>answer(false));window.webContents.session.setPermissionCheckHandler(()=>false);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  ipcMain.once('raw-voice-qa',(event,result)=>{if(event.sender!==window.webContents)return;finish(result?.ok===true,{...result,ownerMicrophoneAccess:false,externalNetwork:false,transport:'fixture signalling; real local WebRTC audio'});});
  window.webContents.on('render-process-gone',()=>finish(false,{error:'Owned QA renderer stopped.'}));
  await window.loadURL('http://127.0.0.1:'+server.address().port+'/');
 }).catch(error=>finish(false,{error:error.message}));
}
