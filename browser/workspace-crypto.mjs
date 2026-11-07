import { scryptAsync } from '@noble/hashes/scrypt.js';
const enc = new TextEncoder(), dec = new TextDecoder();
export const b64 = bytes => { let s=''; for(const b of bytes)s+=String.fromCharCode(b);return btoa(s); };
export const un64 = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
const join = (...xs) => {const out=new Uint8Array(xs.reduce((n,x)=>n+x.length,0));let n=0;for(const x of xs){out.set(x,n);n+=x.length;}return out;};
const bytes = n=>crypto.getRandomValues(new Uint8Array(n));
const MAX=9*1024*1024,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function base64(value,min,max){if(typeof value!=='string'||value.length>4*Math.ceil(max/3)||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('Invalid encrypted workspace encoding.');const b=un64(value);if(b.length<min||b.length>max||b64(b)!==value)throw Error('Invalid encrypted workspace encoding.');return b;}
function validState(s){if(!s||!UUID.test(s.id)||typeof s.label!=='string'||s.label.length>80||!s.label.trim()||![1,2,3].includes(s.schema)||['projects','tasks','messages','memories','audit'].some(k=>!Array.isArray(s[k]))||!s.settings||typeof s.settings!=='object'||Array.isArray(s.settings))throw Error('Invalid workspace records.');}
export async function deriveWorkspaceKey(password,salt){
 if(typeof password!=='string'||password.length<12||password.length>256)throw Error('Use the workspace passphrase, with at least 12 characters.');
 const raw=await scryptAsync(enc.encode(password),base64(salt,32,32),{N:32768,r:8,p:1,dkLen:32,maxmem:64*1024*1024});
 try{return await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);}finally{raw.fill(0);}
}
async function encrypt(key,value,aad){const iv=bytes(12),data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,...(aad?{additionalData:enc.encode(aad)}:{})},key,enc.encode(value)));return{iv,body:data.subarray(0,-16),tag:data.subarray(-16)};}
async function decrypt(key,iv,body,tag,aad){return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,...(aad?{additionalData:enc.encode(aad)}:{})},key,join(body,tag)));}
export function newWorkspace(label){if(typeof label!=='string'||!label.trim()||label.length>80)throw Error('Name your workspace in 80 characters or fewer.');return {schema:1,id:crypto.randomUUID(),label:label.trim(),createdAt:new Date().toISOString(),projects:[],tasks:[],messages:[],memories:[],audit:[],settings:{autoLockMinutes:15,mode:'beginner',reducedMotion:false,model:'',greeting:''}};}
export const newSalt=()=>b64(bytes(32));
export async function sealWorkspace(state,key,salt,revision){
 validState(state);base64(salt,32,32);if(!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid workspace revision.');
 // Credentials and machine permissions never originate in this browser editor.
 const safe=structuredClone(state);delete safe.providerSecrets;delete safe.mailSecrets;
 const plaintext=JSON.stringify(safe);if(enc.encode(plaintext).length>6*1024*1024)throw Error('Workspace is too large for online saving. Keep a desktop backup.');
 const inner=await encrypt(key,plaintext);
 const backup=JSON.stringify({format:'raw-encrypted-workspace',version:1,id:state.id,label:state.label,salt,payload:b64(join(inner.iv,inner.tag,inner.body))});
 if(enc.encode(backup).length>MAX)throw Error('Workspace is too large for online saving.');const outer=await encrypt(key,backup,state.id+'|'+revision);
 return {format:'raw-online-encrypted',version:1,id:state.id,revision,salt,iv:b64(outer.iv),tag:b64(outer.tag),data:b64(outer.body)};
}
export async function openWorkspace(envelope,key){
 if(envelope?.format!=='raw-online-encrypted'||envelope.version!==1||!UUID.test(envelope.id)||!Number.isSafeInteger(envelope.revision)||envelope.revision<1)throw Error('Invalid encrypted workspace.');
 base64(envelope.salt,32,32);const iv=base64(envelope.iv,12,12),body=base64(envelope.data,1,MAX),tag=base64(envelope.tag,16,16);
 try{
 const backup=JSON.parse(await decrypt(key,iv,body,tag,envelope.id+'|'+envelope.revision));
 if(backup.id!==envelope.id||backup.salt!==envelope.salt||backup.format!=='raw-encrypted-workspace'||backup.version!==1)throw Error();
 const p=base64(backup.payload,29,MAX),state=JSON.parse(await decrypt(key,p.subarray(0,12),p.subarray(28),p.subarray(12,28)));validState(state);
 if(state.id!==envelope.id||state.label!==backup.label)throw Error();
 delete state.providerSecrets;delete state.mailSecrets;return state;
 }catch{throw Error('The passphrase is wrong or the encrypted workspace is damaged.');}
}
export async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function portableBackup(state,key,salt){const e=await sealWorkspace(state,key,salt,1);return await decrypt(key,un64(e.iv),un64(e.data),un64(e.tag),e.id+'|1');}
