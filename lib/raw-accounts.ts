// App-owned accounts for the explicitly public beta. Sites' own access gate is
// untouched. No owner identifiers, mail addresses or service credentials live here.
import {community,groupAction} from "./raw-community.ts";
import {announcementList,operatorAction,voiceAction,challengeAction} from "./raw-extra.ts";
type Bound = { first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<{results:T[]}>; run(): Promise<{meta:{changes?:number}}> };
export type RawDatabase = { prepare(sql:string): Bound & {bind(...values:unknown[]):Bound}; batch(statements:Bound[]):Promise<unknown[]> };
export type RawBucket = {put(key:string,value:string):Promise<unknown>;get(key:string):Promise<{text():Promise<string>}|null>;delete(key:string):Promise<unknown>};
type User = {id:string;username:string;salt:string;verifier:string;client_salt:string};
const enc = new TextEncoder();
export const PASSWORD_ROUNDS = 100_000;
const MAX_BODY = 12 * 1024 * 1024;
const QUOTA = 128 * 1024 * 1024;
const COOKIE = "__Host-raw_session";
const LIFETIME = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const allowed = new Set(["register","login","logout","logout-all","workspaces","download","upload","session","health","community","groups","operator","announcements","voice","challenges"]);
function fail(status:number,message:string):never {throw Object.assign(new Error(message),{status});}
function sql(db:RawDatabase,query:string,...values:unknown[]) {return db.prepare(query).bind(...values);}
export function base64(bytes:Uint8Array) {let out="";for(let i=0;i<bytes.length;i+=0x4000)out+=String.fromCharCode(...bytes.subarray(i,i+0x4000));return btoa(out);}
function random(n:number) {return base64(crypto.getRandomValues(new Uint8Array(n)));}
export async function digest(input:string) {return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(input))),x=>x.toString(16).padStart(2,"0")).join("");}
function decoded(s:string) {return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function verifier(password:string,salt:string) {const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);return base64(new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:decoded(salt),iterations:PASSWORD_ROUNDS},key,256)));}
function equal(a:string,b:string) {let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
function publicUser(u:User) {return {id:u.id,username:u.username,display:u.username,clientSalt:u.client_salt};}
function cookie(token:string,clear=false) {return `${COOKIE}=${clear?"":token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear?0:86400}`;}
function tokenFor(req:Request) {const auth=req.headers.get("authorization");if(auth)return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth)?.[1]||"";return req.headers.get("cookie")?.split(";").map(s=>s.trim()).find(s=>s.startsWith(COOKIE+"="))?.slice(COOKIE.length+1)||"";}
function json(status:number,data:unknown,extra:Record<string,string>={}) {return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...extra}});}
async function body(req:Request,max=16384):Promise<Record<string,any>> {if(Number(req.headers.get("content-length")||0)>max)fail(413,"Request too large.");const reader=req.body?.getReader();let n=0;const chunks:Uint8Array[]=[];try{if(reader)for(;;){const x=await reader.read();if(x.done)break;n+=x.value.byteLength;if(n>max){await reader.cancel();fail(413,"Request too large.");}chunks.push(x.value);}}finally{reader?.releaseLock();}const buffer=new Uint8Array(n);let p=0;for(const c of chunks){buffer.set(c,p);p+=c.length;}let value;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));}catch{fail(400,"Invalid request.");}if(!value||Array.isArray(value)||typeof value!=="object")fail(400,"Invalid request.");return value;}
function username(value:unknown) {if(typeof value!=="string"||!/^[a-zA-Z0-9_]{3,32}$/.test(value))fail(400,"Use 3–32 letters, numbers or underscores for your username.");return value.toLowerCase();}
function password(value:unknown) {if(typeof value!=="string"||value.length<12||value.length>256)fail(400,"Use a password of 12–256 characters.");return value;}
function base64Size(value:unknown,min:number,max:number) {if(typeof value!=="string"||value.length>Math.ceil(max/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail(400,"Invalid encrypted snapshot.");let bytes:Uint8Array;try{bytes=decoded(value);}catch{fail(400,"Invalid encrypted snapshot.");}if(bytes.length<min||bytes.length>max||base64(bytes)!==value)fail(400,"Invalid encrypted snapshot.");}
export function validateEnvelope(x:any) {if(!x||x.format!=="raw-online-encrypted"||x.version!==1||!UUID.test(x.id)||!Number.isSafeInteger(x.revision)||x.revision<1)fail(400,"Invalid encrypted snapshot.");for(const[k,min,max]of [["salt",32,32],["iv",12,12],["tag",16,16],["data",1,9*1024*1024]]as const)base64Size(x[k],min,max);return x;}
async function rate(db:RawDatabase,key:string,limit:number,now:number,window=60000) {const slot=Math.floor(now/window),id=await digest(key+"|"+slot);const r=await sql(db,"INSERT INTO raw_rates(id,attempts,until) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1 RETURNING attempts",id,(slot+1)*window).first<{attempts:number}>();if(!r||r.attempts>limit)fail(429,"Please try again later.");}
async function authenticate(req:Request,db:RawDatabase,now:number) {const token=tokenFor(req);if(!/^[A-Za-z0-9_-]{43}$/.test(token))fail(401,"Sign in to continue.");const u=await sql(db,"SELECT u.* FROM raw_sessions s JOIN raw_users u ON u.id=s.owner WHERE s.digest=? AND s.expires>?",await digest(token),now).first<User>();if(!u)fail(401,"Sign in to continue.");return {user:u,token};}
async function issue(db:RawDatabase,u:User,now:number,browser:boolean) {const token=random(32).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");await db.batch([sql(db,"DELETE FROM raw_sessions WHERE expires<=?",now),sql(db,"INSERT INTO raw_sessions(digest,owner,expires,created) VALUES(?,?,?,?)",await digest(token),u.id,now+LIFETIME,now),sql(db,"DELETE FROM raw_sessions WHERE owner=? AND digest NOT IN (SELECT digest FROM raw_sessions WHERE owner=? ORDER BY created DESC,rowid DESC LIMIT 8)",u.id,u.id)]);return json(200,{signedIn:true,user:publicUser(u),...(!browser?{token}:{})},{"Set-Cookie":cookie(token)});}

export async function handleRawAccount(req:Request,db:RawDatabase,clock=Date.now,bucket?:RawBucket,operatorKey="",options:{allowCoinChallenges?:boolean}={}):Promise<Response> {
 try {
  const url=new URL(req.url),route=url.pathname.replace(/^\/api\//,"/").slice(1);if(!allowed.has(route)||url.search)fail(404,"Not found.");
  if(route==="health"&&req.method==="GET")return json(200,{ok:true});
  const origin=req.headers.get("origin"),fetchSite=req.headers.get("sec-fetch-site");
  if(origin&&origin!==url.origin||fetchSite&&!["same-origin","none"].includes(fetchSite))fail(403,"Request not allowed.");
  const browser=!!origin||!!fetchSite||!!req.headers.get("cookie");
  if(req.method!=="POST"&&!(req.method==="GET"&&route==="session"))fail(405,"Request not allowed.");
  if(req.method==="POST"&&req.headers.get("content-type")?.split(";")[0].trim()!=="application/json")fail(403,"Request not allowed.");
  // Cookie-authenticated mutations must carry an explicit same-origin header.
  if(req.method==="POST"&&req.headers.get("cookie")&&!req.headers.get("authorization")&&origin!==url.origin)fail(403,"Request not allowed.");
  const now=clock(),ip=req.headers.get("cf-connecting-ip")||"unknown";
  await rate(db,"global",1200,now);
  await sql(db,"DELETE FROM raw_rates WHERE id IN (SELECT id FROM raw_rates WHERE until<? LIMIT 20)",now).run();
  await rate(db,"ip|"+ip,180,now);
  if(route==="operator") {await rate(db,"operator-ip|"+ip,20,now);return json(200,await operatorAction(db,req,await body(req),now,operatorKey));}
  if(route==="register"||route==="login") {
   const a=await body(req),name=username(a.username),secret=password(a.password);
   await rate(db,"auth-ip|"+ip,12,now);await rate(db,"auth-name|"+name,10,now);await rate(db,"auth-global",60,now);
   if(route==="register") {
    const salt=random(32),u:User={id:crypto.randomUUID(),username:name,salt,verifier:await verifier(secret,salt),client_salt:random(32)};
    const inserted=await sql(db,"INSERT OR IGNORE INTO raw_users(id,username,salt,verifier,client_salt,created) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM raw_users)<1000",u.id,u.username,u.salt,u.verifier,u.client_salt,now).run();
    if(!inserted.meta.changes)fail(409,"That username is unavailable, or beta registration is full.");return issue(db,u,now,browser);
   }
   const u=await sql(db,"SELECT * FROM raw_users WHERE username=?",name).first<User>();const expected=u?.verifier||"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
   const test=await verifier(secret,u?.salt||"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");if(!u||!equal(test,expected))fail(401,"Username or password incorrect.");return issue(db,u,now,browser);
  }
  let session;try{session=await authenticate(req,db,now);}catch(e){if(route==="session")return json(200,{signedIn:false,user:null});throw e;}
  const {user,token}=session;
  if(route==="session")return json(200,{signedIn:true,user:publicUser(user)});
  if(route==="upload") {await rate(db,"upload-owner|"+user.id,4,now);await rate(db,"upload-global",20,now);}
  const a=await body(req,route==="upload"?MAX_BODY:route==="voice"?40000:route==="community"?32768:16384);
  if(route==="logout"||route==="logout-all") {await sql(db,route==="logout"?"DELETE FROM raw_sessions WHERE digest=?":"DELETE FROM raw_sessions WHERE owner=?",route==="logout"?await digest(token):user.id).run();return json(200,{signedOut:true},{"Set-Cookie":cookie("",true)});}
  if(route==="community"||route==="groups") {await rate(db,"social|"+user.id,120,now);return json(200,await (route==="community"?community:groupAction)(db,user,a,now));}
  if(route==="announcements")return json(200,await announcementList(db));
  if(route==="voice"||route==="challenges") {await rate(db,route+"|"+user.id,180,now);return json(200,await (route==="voice"?voiceAction(db,user,a,now):challengeAction(db,user,a,now,options.allowCoinChallenges===true)));}
  if(route==="workspaces") {const rows=await sql(db,"SELECT space AS id,max(revision) AS revision,max(created) AS created FROM raw_versions WHERE owner=? GROUP BY space ORDER BY created DESC LIMIT 10",user.id).all();return json(200,{workspaces:rows.results});}
  if(typeof a.id!=="string"||!UUID.test(a.id))fail(400,"Invalid workspace identity.");
  if(route==="download") {if(a.revision!==undefined&&(!Number.isSafeInteger(a.revision)||a.revision<1))fail(400,"Invalid revision.");const r=await sql(db,a.revision===undefined?"SELECT payload,digest,revision FROM raw_versions WHERE owner=? AND space=? ORDER BY revision DESC LIMIT 1":"SELECT payload,digest,revision FROM raw_versions WHERE owner=? AND space=? AND revision=?",...a.revision===undefined?[user.id,a.id]:[user.id,a.id,a.revision]).first<{payload:string;digest:string;revision:number}>();if(!r)fail(404,"Workspace version not found.");if(!bucket||!r.payload.startsWith("r2:raw/envelopes/"+user.id+"/"))fail(503,"Encrypted version storage is unavailable.");const obj=await bucket.get(r.payload.slice(3));if(!obj)fail(503,"Encrypted version storage is unavailable. Existing history was retained.");const stored=await obj.text();if(enc.encode(stored).length>MAX_BODY||await digest(stored)!==r.digest)fail(503,"Encrypted version integrity check failed. Existing history was retained.");return json(200,{envelope:JSON.parse(stored),digest:r.digest,revision:r.revision});}
  if(!Number.isSafeInteger(a.expectedRevision)||a.expectedRevision<0)fail(400,"Invalid revision.");validateEnvelope(a.envelope);if(a.envelope.id!==a.id||a.envelope.revision!==a.expectedRevision+1)fail(400,"Snapshot revision mismatch.");
  const payload=JSON.stringify(a.envelope),bytes=enc.encode(payload).length,sha=await digest(payload);
  if(!bucket)fail(503,"Encrypted version storage is unavailable.");
  // Refuse known stale/full uploads before writing R2. The final conditional
  // INSERT still enforces all limits when concurrent requests race this read.
  const preflight=await sql(db,`SELECT
   (SELECT coalesce(max(revision),0) FROM raw_versions WHERE owner=? AND space=?) AS revision,
   (SELECT count(*) FROM raw_versions WHERE owner=? AND space=?) AS versions,
   (SELECT coalesce(sum(bytes),0) FROM raw_versions WHERE owner=?) AS ownerBytes,
   (SELECT count(DISTINCT space) FROM raw_versions WHERE owner=?) AS spaces,
   (SELECT count(*) FROM raw_versions) AS totalVersions,
   (SELECT coalesce(sum(bytes),0) FROM raw_versions) AS totalBytes`,user.id,a.id,user.id,a.id,user.id,user.id).first<{revision:number;versions:number;ownerBytes:number;spaces:number;totalVersions:number;totalBytes:number}>();
  if(!preflight)fail(503,"Version storage unavailable.");if(preflight.revision!==a.expectedRevision)fail(409,"A newer version exists. Local and server progress were preserved.");
  if(preflight.versions>=100||preflight.ownerBytes+bytes>QUOTA||preflight.revision===0&&preflight.spaces>=10||preflight.totalVersions>=10000||preflight.totalBytes+bytes>512*1024*1024)fail(507,"Version storage limit reached. Existing versions were retained; keep a local backup.");
  // Payloads exceed D1's per-row limit. Put opaque ciphertext durably in R2 first,
  // then commit its unique server-generated reference with the atomic metadata CAS.
  const objectKey="raw/envelopes/"+user.id+"/"+crypto.randomUUID(),reference="r2:"+objectKey;
  await bucket.put(objectKey,payload);
  try {
  // One conditional INSERT is the compare-and-swap transaction. Concurrent writes
  // cannot both observe the same head and neither can overwrite an old version.
  const out=await sql(db,`INSERT INTO raw_versions(owner,space,revision,payload,digest,bytes,created)
    SELECT ?,?,?,?,?,?,? WHERE coalesce((SELECT max(revision) FROM raw_versions WHERE owner=? AND space=?),0)=?
    AND (SELECT count(*) FROM raw_versions WHERE owner=? AND space=?)<100
    AND (SELECT coalesce(sum(bytes),0) FROM raw_versions WHERE owner=?)+?<=?
    AND ((SELECT count(DISTINCT space) FROM raw_versions WHERE owner=?)<10 OR EXISTS(SELECT 1 FROM raw_versions WHERE owner=? AND space=?))
    AND (SELECT count(*) FROM raw_versions)<10000
    AND (SELECT coalesce(sum(bytes),0) FROM raw_versions)+?<=?`,user.id,a.id,a.envelope.revision,reference,sha,bytes,now,user.id,a.id,a.expectedRevision,user.id,a.id,user.id,bytes,QUOTA,user.id,user.id,a.id,bytes,512*1024*1024).run();
  if(!out.meta.changes) {const head=await sql(db,"SELECT coalesce(max(revision),0) AS revision FROM raw_versions WHERE owner=? AND space=?",user.id,a.id).first<{revision:number}>();if(head?.revision!==a.expectedRevision)fail(409,"A newer version exists. Local and server progress were preserved.");fail(507,"Version storage limit reached. Existing versions were retained; keep a local backup.");}
  return json(200,{revision:a.envelope.revision,digest:sha});
  } catch(error) {
   // An ambiguous D1 response may have committed. Never delete a referenced
   // object; if this verification itself fails leave an orphan for later review.
   try {const committed=await sql(db,"SELECT 1 AS present FROM raw_versions WHERE owner=? AND payload=? LIMIT 1",user.id,reference).first();if(!committed)await bucket.delete(objectKey);}catch{}
   throw error;
  }
 } catch(e) {const error=e as Error&{status?:number};return json(error.status||503,{error:error.status?error.message:"Service busy. Please try again later."});}
}
