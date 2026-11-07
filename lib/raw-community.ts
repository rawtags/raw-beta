import type {RawDatabase} from "./raw-accounts";
type User={id:string;username:string};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(status:number,message:string):never {throw Object.assign(new Error(message),{status});}
function sql(db:RawDatabase,q:string,...v:unknown[]) {return db.prepare(q).bind(...v);}
function text(v:unknown,max:number) {if(typeof v!=="string"||!v.trim()||v.length>max)fail(400,"Please enter text within the limit.");return v.trim();}
function id(v:unknown):string {if(typeof v!=="string"||!UUID.test(v))fail(400,"Invalid item.");return v;}
function token() {const a=crypto.getRandomValues(new Uint8Array(24));return btoa(String.fromCharCode(...a)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");}
async function sha(v:string) {return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))),x=>x.toString(16).padStart(2,"0")).join("");}
export async function community(db:RawDatabase,u:User,a:Record<string,any>,now:number) {
 if(a.action==="feed") {
  const kind=a.kind===undefined?null:text(a.kind,20);if(kind&&!["post","forum","preset","project"].includes(kind))fail(400,"Choose a post type.");
  const before=a.before===undefined?Number.MAX_SAFE_INTEGER:a.before;if(!Number.isSafeInteger(before)||before<0)fail(400,"Invalid page.");
  const posts=await sql(db,`SELECT p.id,p.kind,p.title,p.body,p.template,p.created,u.username,
   (p.owner=?) AS owned,(SELECT count(*) FROM raw_likes l WHERE l.post=p.id) AS likes,
   EXISTS(SELECT 1 FROM raw_likes l WHERE l.post=p.id AND l.actor=?) AS liked
   FROM raw_posts p JOIN raw_users u ON u.id=p.owner WHERE p.hidden=0 AND p.created<? AND (? IS NULL OR p.kind=?) ORDER BY p.created DESC,p.id DESC LIMIT 40`,u.id,u.id,before,kind,kind).all<any>();
  const balance=await sql(db,"SELECT coalesce(sum(delta),0) AS coins FROM raw_coins WHERE owner=?",u.id).first<{coins:number}>();
  return {posts:posts.results.map(p=>({...p,owned:!!p.owned,liked:!!p.liked,template:p.template?JSON.parse(p.template):null})),coins:balance?.coins||0};
 }
 if(a.action==="post") {
  if(!["post","forum","preset","project"].includes(a.kind))fail(400,"Choose a post type.");
  const title=text(a.title,100),body=text(a.body,4000);let template:string|null=null;
  if(a.kind==="preset") {if(!a.template||typeof a.template!=="object"||Array.isArray(a.template))fail(400,"Add a prompt or theme to your preset.");const clean:{prompt?:string;theme?:string}={};if(a.template.prompt!==undefined)clean.prompt=text(a.template.prompt,12000);if(a.template.theme!==undefined) {if(!["operator","neutral","ocean","ember","violet","forest","ice"].includes(a.template.theme))fail(400,"Choose a supported theme.");clean.theme=a.template.theme;}if(!Object.keys(clean).length)fail(400,"Add a prompt or theme to your preset.");template=JSON.stringify(clean);}
  const postId=crypto.randomUUID();const out=await sql(db,`INSERT INTO raw_posts(id,owner,kind,title,body,template,created,hidden)
   SELECT ?,?,?,?,?,?,?,0 WHERE (SELECT count(*) FROM raw_posts WHERE owner=? AND created>?)<20 AND (SELECT count(*) FROM raw_posts)<10000`,postId,u.id,a.kind,title,body,template,now,u.id,now-86400000).run();
  if(!out.meta.changes)fail(429,"Posting limit reached. Please try another day.");return {posted:true,id:postId};
 }
 if(a.action==="like") {
  const postId=id(a.postId),post=await sql(db,"SELECT owner FROM raw_posts WHERE id=? AND hidden=0",postId).first<{owner:string}>();if(!post)fail(404,"Post unavailable.");if(post.owner===u.id)fail(400,"You cannot earn coins by liking your own post.");
  // Permanent unique likes and immutable event IDs make retries idempotent. A
  // client never supplies the balance, recipient, value or earning event ID.
  await db.batch([sql(db,"INSERT OR IGNORE INTO raw_likes(post,actor,created) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM raw_posts WHERE id=? AND hidden=0 AND owner<>?)",postId,u.id,now,postId,u.id),sql(db,"INSERT OR IGNORE INTO raw_coins(event,owner,delta,created) SELECT ?,p.owner,1,? FROM raw_posts p JOIN raw_likes l ON l.post=p.id WHERE p.id=? AND l.actor=? AND p.owner<>?",`like:${postId}:${u.id}`,now,postId,u.id,u.id)]);
  return {liked:true};
 }
 if(a.action==="report") {const postId=id(a.postId),reason=text(a.reason,500);const out=await sql(db,"INSERT INTO raw_reports(id,reporter,post,reason,created) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM raw_posts WHERE id=?) AND (SELECT count(*) FROM raw_reports WHERE reporter=? AND created>?)<10",crypto.randomUUID(),u.id,postId,reason,now,postId,u.id,now-86400000).run();if(!out.meta.changes)fail(429,"Report unavailable or daily limit reached.");return {reported:true};}
 fail(400,"Choose a supported action.");
}
async function membership(db:RawDatabase,owner:string,group:string) {const row=await sql(db,"SELECT g.id,g.name,g.owner FROM raw_groups g JOIN raw_members m ON m.group_id=g.id WHERE m.owner=? AND g.id=?",owner,group).first<{id:string;name:string;owner:string}>();if(!row)fail(404,"Group unavailable.");return row;}
export async function groupAction(db:RawDatabase,u:User,a:Record<string,any>,now:number) {
 if(a.action==="list") {const rows=await sql(db,"SELECT g.id,g.name,g.created,(g.owner=?) AS owned,(SELECT count(*) FROM raw_members n WHERE n.group_id=g.id) AS members FROM raw_groups g JOIN raw_members m ON m.group_id=g.id WHERE m.owner=? ORDER BY g.created DESC LIMIT 20",u.id,u.id).all();return {groups:rows.results};}
 if(a.action==="create") {const name=text(a.name,60),groupId=crypto.randomUUID(),code=token();await db.batch([
  sql(db,"INSERT INTO raw_groups(id,owner,name,invite_digest,created) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM raw_groups WHERE owner=?)<10 AND (SELECT count(*) FROM raw_members WHERE owner=?)<20 AND (SELECT count(*) FROM raw_groups)<1000",groupId,u.id,name,await sha(code),now,u.id,u.id),
  sql(db,"INSERT INTO raw_members(group_id,owner,created) SELECT id,?,? FROM raw_groups WHERE id=? AND owner=?",u.id,now,groupId,u.id)
 ]);if(!await sql(db,"SELECT 1 AS present FROM raw_groups WHERE id=? AND owner=?",groupId,u.id).first())fail(507,"Group limit reached.");return {group:{id:groupId,name,owned:true,members:1},inviteCode:code};}
 if(a.action==="join") {if(typeof a.inviteCode!=="string"||!/^[A-Za-z0-9_-]{32}$/.test(a.inviteCode))fail(400,"Enter a group invite code.");const inviteDigest=await sha(a.inviteCode),g=await sql(db,"SELECT id,name FROM raw_groups WHERE invite_digest=?",inviteDigest).first<{id:string;name:string}>();if(!g)fail(404,"Invite unavailable.");await sql(db,"INSERT OR IGNORE INTO raw_members(group_id,owner,created) SELECT id,?,? FROM raw_groups WHERE id=? AND invite_digest=? AND (SELECT count(*) FROM raw_members WHERE group_id=?)<16 AND (SELECT count(*) FROM raw_members WHERE owner=?)<20",u.id,now,g.id,inviteDigest,g.id,u.id).run();await membership(db,u.id,g.id);return {joined:true,group:g};}
 const groupId=id(a.groupId),g=await membership(db,u.id,groupId);
 if(a.action==="invite") {if(g.owner!==u.id)fail(403,"Only the group owner can create a new invite.");const code=token();await sql(db,"UPDATE raw_groups SET invite_digest=? WHERE id=? AND owner=?",await sha(code),groupId,u.id).run();return {inviteCode:code};}
 if(a.action==="leave") {if(g.owner===u.id)fail(400,"The group owner cannot leave their group.");await sql(db,"DELETE FROM raw_members WHERE group_id=? AND owner=?",groupId,u.id).run();return {left:true};}
 if(a.action==="remove") {const name=text(a.username,32).toLowerCase();if(g.owner!==u.id||name===u.username)fail(403,"Only the group owner can remove another member.");await sql(db,"DELETE FROM raw_members WHERE group_id=? AND owner<>? AND owner IN (SELECT id FROM raw_users WHERE username=?)",groupId,g.owner,name).run();return {removed:true};}
 if(a.action==="messages") {const after=a.after===undefined?0:a.after;if(!Number.isSafeInteger(after)||after<0)fail(400,"Invalid message position.");const rows=after===0?await sql(db,"SELECT m.id,m.body,m.created,u.username FROM raw_group_messages m JOIN raw_users u ON u.id=m.owner WHERE m.group_id=? AND EXISTS(SELECT 1 FROM raw_members WHERE group_id=? AND owner=?) ORDER BY m.id DESC LIMIT 100",groupId,groupId,u.id).all():await sql(db,"SELECT m.id,m.body,m.created,u.username FROM raw_group_messages m JOIN raw_users u ON u.id=m.owner WHERE m.group_id=? AND m.id>? AND EXISTS(SELECT 1 FROM raw_members WHERE group_id=? AND owner=?) ORDER BY m.id LIMIT 100",groupId,after,groupId,u.id).all();return {messages:after===0?rows.results.reverse():rows.results};}
 if(a.action==="send") {const body=text(a.body,2000);const out=await sql(db,"INSERT INTO raw_group_messages(group_id,owner,body,created) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM raw_members WHERE group_id=? AND owner=?) AND (SELECT count(*) FROM raw_group_messages WHERE group_id=?)<1000 AND (SELECT count(*) FROM raw_group_messages WHERE owner=? AND created>?)<60 AND (SELECT count(*) FROM raw_group_messages)<50000",groupId,u.id,body,now,groupId,u.id,groupId,u.id,now-60000).run();if(!out.meta.changes)fail(429,"Message limit reached. Your message was not sent.");return {sent:true};}
 fail(400,"Choose a supported action.");
}
