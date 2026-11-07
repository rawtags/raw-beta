import {sha256} from '@noble/hashes/sha2.js';

export type ReleaseBindings=Pick<Cloudflare.Env,'BUCKET'|'RAW_OPERATOR_KEY'>;
export const RELEASE_PUBLIC_KEY='MCowBQYDK2VwAyEAA6j8yWChLQns5wF6faqkHNHc0a7E5efjDAo1r4QLfr0=';
const ORIGIN='https://raw-private-beta.rawtags.chatgpt.site';
const MAX_INSTALLER=400*1024*1024,MAX_PART=6*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const enc=new TextEncoder();
const json=(status:number,value:unknown)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const un64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function fail(message:string):never{throw Error(message);}
async function admin(req:Request,env:ReleaseBindings){
 const value=req.headers.get('x-raw-operator')||'',expected=env.RAW_OPERATOR_KEY||'';
 if(expected.length<43||value.length!==expected.length)fail('Not authorised.');
 const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(value)),crypto.subtle.digest('SHA-256',enc.encode(expected))]);
 let difference=0;new Uint8Array(a).forEach((v,i)=>difference|=v^new Uint8Array(b)[i]);if(difference)fail('Not authorised.');
 if(req.headers.has('origin')||req.headers.has('sec-fetch-site'))fail('Use the private publishing tool.');
}
async function body(req:Request,max:number){
 if(Number(req.headers.get('content-length')||0)>max)fail('Upload exceeds its limit.');
 const reader=req.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{if(reader)for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>max){await reader.cancel();fail('Upload exceeds its limit.');}chunks.push(r.value);}}finally{reader?.releaseLock();}
 const out=new Uint8Array(size);let position=0;for(const chunk of chunks){out.set(chunk,position);position+=chunk.length;}return out;
}
function shaIdentity(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('Invalid release identity.');return value;}
function objectIdentity(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))fail('Invalid upload identity.');return value;}
function objectKey(sha:unknown,id:unknown){return 'releases/installers/'+shaIdentity(sha)+'/'+objectIdentity(id)+'.exe';}
function validObjectKey(key:unknown):key is string{return typeof key==='string'&&/^releases\/installers\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.exe$/.test(key);}
type Upload={sha256:string;objectId:string;uploadId:string;bytes:number;created:number};
async function uploadState(bucket:R2Bucket,id:unknown,sha:unknown,uploadId:unknown){
 const objectId=objectIdentity(id),identity=shaIdentity(sha),object=await bucket.get('releases/upload-state/'+objectId+'.json');
 if(!object)fail('Upload unavailable.');const text=await object.text();if(text.length>4096)fail('Invalid upload state.');const state=JSON.parse(text) as Upload;
 if(state.objectId!==objectId||state.sha256!==identity||state.uploadId!==uploadId||typeof uploadId!=='string'||uploadId.length>500||!Number.isSafeInteger(state.bytes)||state.bytes<1||state.bytes>MAX_INSTALLER||!Number.isFinite(state.created)||Date.now()-state.created>4*3600000)fail('Upload unavailable.');
 return {...state,key:objectKey(identity,objectId)};
}
export function validateReleaseManifest(m:any){
 const expiry=typeof m?.expires==='string'?Date.parse(m.expires):NaN;
 if(m?.schema!==1||m.platform!=='win32-x64'||m.url!==ORIGIN+'/Raw-Setup.exe'||typeof m.version!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(m.version)||m.version.split('.').map(Number).join('.')!==m.version||!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+30*86400000||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>MAX_INSTALLER||typeof m.notes!=='string'||m.notes.length>12000)fail('Invalid release manifest.');
 shaIdentity(m.sha256);return m;
}
async function verifyEnvelope(value:string,max:number,key:CryptoKey){
 const envelope=JSON.parse(value);if(typeof envelope?.payload!=='string'||envelope.payload.length>max||typeof envelope.signature!=='string'||envelope.signature.length>200||!await crypto.subtle.verify('Ed25519',key,un64(envelope.signature),enc.encode(envelope.payload)))fail('Publisher signature did not match.');
 return JSON.parse(envelope.payload);
}
async function verifyInstaller(bucket:R2Bucket,key:string,manifest:{bytes:number;sha256:string}){
 const file=await bucket.get(key);if(!file||file.size!==manifest.bytes||!file.body)fail('Complete installer upload first.');
 // The signed digest is checked against the complete stored stream, never its
 // filename or multipart ETag. Working memory stays bounded to one input chunk.
 const hash=sha256.create(),reader=file.body.getReader();let count=0;
 try{for(;;){const part=await reader.read();if(part.done)break;count+=part.value.byteLength;if(count>manifest.bytes||count>MAX_INSTALLER){await reader.cancel();fail('Installer size did not match.');}hash.update(part.value);}}finally{reader.releaseLock();}
 const actual=Array.from(hash.digest(),x=>x.toString(16).padStart(2,'0')).join('');
 if(count!==manifest.bytes||actual!==manifest.sha256)fail('Installer checksum did not match.');
}
export async function uploadRelease(req:Request,env:ReleaseBindings){try{
 await admin(req,env);const bucket=env.BUCKET;if(!bucket)fail('Storage unavailable.');const url=new URL(req.url);
 if(req.method==='PUT'){
  const part=Number(url.searchParams.get('part'));if(!Number.isInteger(part)||part<1||part>80)fail('Invalid upload part.');
  const state=await uploadState(bucket,url.searchParams.get('objectId'),url.searchParams.get('sha'),url.searchParams.get('upload'));
  if(await bucket.head(state.key))fail('Completed release objects cannot be changed.');
  const bytes=await body(req,MAX_PART);if(!bytes.length)fail('An upload part cannot be empty.');
  return json(200,await bucket.resumeMultipartUpload(state.key,state.uploadId).uploadPart(part,bytes));
 }
 if(req.method!=='POST')return json(405,{error:'Not allowed.'});
 const a=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,512*1024)));
 if(a?.action==='start'){
  if(!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>MAX_INSTALLER)fail('Invalid release size.');
  const identity=shaIdentity(a.sha256),objectId=crypto.randomUUID(),key=objectKey(identity,objectId);
  const result=await bucket.createMultipartUpload(key,{httpMetadata:{contentType:'application/octet-stream',contentDisposition:'attachment; filename="Raw-Setup.exe"'}});
  try{await bucket.put('releases/upload-state/'+objectId+'.json',JSON.stringify({sha256:identity,objectId,uploadId:result.uploadId,bytes:a.bytes,created:Date.now()}));}catch(error){try{await result.abort();}catch{}throw error;}
  return json(200,{uploadId:result.uploadId,objectId});
 }
 if(a?.action==='complete'){
  if(!Array.isArray(a.parts)||a.parts.length<1||a.parts.length>80||a.parts.some((p:any,i:number)=>p?.partNumber!==i+1||typeof p.etag!=='string'||!p.etag||p.etag.length>300))fail('Invalid release parts.');
  const state=await uploadState(bucket,a.objectId,a.sha256,a.uploadId);
  // A UUID is generated only by start. A completed provider upload cannot be
  // resumed; another start always gets a different key, even for the same hash.
  const existing=await bucket.head(state.key),file=existing||await bucket.resumeMultipartUpload(state.key,state.uploadId).complete(a.parts);
  if(file.size!==state.bytes||file.size<1||file.size>MAX_INSTALLER)fail('Completed size did not match the declared release size.');
  await bucket.put('releases/candidates/'+state.sha256+'.json',JSON.stringify({key:state.key,bytes:file.size}));
  return json(200,{completed:true,bytes:file.size});
 }
 if(a?.action==='publish'){
  if(typeof a.manifest!=='string'||a.manifest.length>65536||typeof a.announcements!=='string'||a.announcements.length>131072)fail('Invalid release files.');
  const publicKey=await crypto.subtle.importKey('spki',un64(RELEASE_PUBLIC_KEY),'Ed25519',false,['verify']);
  const m=validateReleaseManifest(await verifyEnvelope(a.manifest,64000,publicKey)),feed=await verifyEnvelope(a.announcements,131072,publicKey);
  if(feed?.schema!==1||!Array.isArray(feed.releases)||!feed.releases.length||feed.releases.length>40||feed.releases[0]?.version!==m.version)fail('Announcement version did not match.');
  const index=await bucket.get('releases/candidates/'+m.sha256+'.json');if(!index)fail('Complete installer upload first.');const text=await index.text();if(text.length>2048)fail('Invalid release candidate.');const candidate=JSON.parse(text);
  if(!validObjectKey(candidate?.key)||!candidate.key.startsWith('releases/installers/'+m.sha256+'/')||candidate.bytes!==m.bytes)fail('Invalid release candidate.');
  await verifyInstaller(bucket,candidate.key,m);
  // One pointer binds all three public downloads to this verified immutable key.
  await bucket.put('releases/current.json',JSON.stringify({key:candidate.key,manifest:a.manifest,announcements:a.announcements}),{httpMetadata:{contentType:'application/json'}});
  return json(200,{published:true,version:m.version});
 }
 return json(400,{error:'Choose a supported publishing action.'});
 }catch{return json(403,{error:'Publishing request refused.'});}}
export async function readRelease(name:'installer'|'manifest'|'announcements',env:ReleaseBindings){try{
 const bucket=env.BUCKET;if(!bucket)return json(503,{error:'Release storage unavailable.'});
 if(!['installer','manifest','announcements'].includes(name))return json(404,{error:'Not found.'});
 const current=await bucket.get('releases/current.json');if(!current)return json(404,{error:'No public release yet.'});const text=await current.text();if(text.length>256*1024)fail('Invalid release pointer.');
 const pointer=JSON.parse(text);if(!validObjectKey(pointer?.key)||typeof pointer.manifest!=='string'||pointer.manifest.length>65536||typeof pointer.announcements!=='string'||pointer.announcements.length>131072)fail('Invalid release pointer.');
 if(name!=='installer')return new Response(name==='manifest'?pointer.manifest:pointer.announcements,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const file=await bucket.get(pointer.key);if(!file||file.size<1||file.size>MAX_INSTALLER)fail('Release unavailable.');
 return new Response(file.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(file.size),'Content-Disposition':'attachment; filename="Raw-Setup.exe"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }catch{return json(503,{error:'Release unavailable.'});}}
