import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handleRawAccount,digest,base64,validateEnvelope} from '../lib/raw-accounts.ts';

// This adapter runs the production SQL against real SQLite. It is not a D1
// deployment/performance certification; a built Worker check is also required.
function fixture(options={}) {
 const conn=new DatabaseSync(':memory:');conn.exec('PRAGMA foreign_keys=ON');
 for(const f of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())conn.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
 const wrap=(query,values=[])=>({
  bind(...a){return wrap(query,a);},
  async first(){return conn.prepare(query).get(...values)||null;},
  async all(){return {results:conn.prepare(query).all(...values)};},
  async run(){const r=conn.prepare(query).run(...values);return {meta:{changes:r.changes}};}
  ,_run(){const r=conn.prepare(query).run(...values);return {meta:{changes:r.changes}};}
 });
 const db={prepare:wrap,async batch(statements){conn.exec('BEGIN');try{const out=[];for(const s of statements)out.push(s._run());conn.exec('COMMIT');return out;}catch(e){conn.exec('ROLLBACK');throw e;}}};
 const objects=new Map(),bucket={async put(k,v){objects.set(k,v);},async get(k){const value=objects.get(k);return value===undefined?null:{async text(){return value;}};},async delete(k){objects.delete(k);}};
 let now=Date.now(),ip=0;
 const request=async(route,data={},options={})=>{
  const headers={'Content-Type':'application/json','CF-Connecting-IP':options.ip||'192.0.2.'+(++ip),...options.headers};
  if(options.token)headers.Authorization='Bearer '+options.token;
  if(options.browser)headers.Origin='https://raw.example';
  if(options.cookie)headers.Cookie=options.cookie;
  const r=await handleRawAccount(new Request('https://raw.example/'+route,{method:options.method||'POST',headers,...options.method==='GET'?{}:{body:typeof data==='string'?data:JSON.stringify(data)}}),db,()=>now,bucket,fixtureOptions.operatorKey||'',fixtureOptions);
  return {status:r.status,body:await r.json(),headers:r.headers};
 };
 const fixtureOptions=options;
 return {db,conn,bucket,objects,request,advance(ms){now+=ms;},close(){conn.close();}};
}
const secret='Long test passphrase 406!',account=(username)=>({username,password:secret});
const envelope=(id,revision,data='one')=>({format:'raw-online-encrypted',version:1,id,revision,salt:base64(new Uint8Array(32)),iv:base64(new Uint8Array(12)),tag:base64(new Uint8Array(16)),data:btoa(data)});

test('unique case-insensitive username; same passwords allowed; only hashed credentials and sessions stored',async()=>{
 const f=fixture();try{
  const a=await f.request('register',account('Alice'));assert.equal(a.status,200);assert.match(a.body.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(a.body.user.username,'alice');assert.ok(a.body.user.clientSalt);
  assert.equal((await f.request('register',account('ALICE'))).status,409);
  assert.equal((await f.request('register',account('Bob'))).status,200);
  const user=f.conn.prepare('SELECT * FROM raw_users WHERE username=?').get('alice');assert.notEqual(user.verifier,secret);assert.notEqual(user.salt,user.client_salt);assert.equal(user.verifier.length,44);
  const session=f.conn.prepare('SELECT * FROM raw_sessions WHERE owner=?').get(user.id);assert.notEqual(session.digest,a.body.token);assert.equal(session.digest,await digest(a.body.token));
  const valid=await f.request('login',account('aLiCe'));assert.equal(valid.status,200);
  assert.equal((await f.request('login',{username:'alice',password:'Wrong password long'})).status,401);
  assert.equal((await f.request('login',account('not_registered'))).body.error,'Username or password incorrect.');
 }finally{f.close();}
});
test('browser cookies are secure and do not expose bearer token; CSRF and cross-origin denied',async()=>{
 const f=fixture();try{
  const r=await f.request('api/register',account('browser'),{browser:true});assert.equal(r.status,200);assert.equal(r.body.token,undefined);const set=r.headers.get('set-cookie');assert.match(set,/HttpOnly; Secure; SameSite=Strict/);const cookie=set.split(';')[0];
  assert.equal((await f.request('api/session',{}, {method:'GET',cookie})).body.user.username,'browser');
  assert.equal((await f.request('api/workspaces',{}, {cookie})).status,403);
  assert.equal((await f.request('api/workspaces',{}, {cookie,browser:true})).status,200);
  assert.equal((await f.request('api/workspaces',{}, {cookie,headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await f.request('api/register',account('evil'),{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.request('api/logout',{}, {cookie,browser:true})).status,200);
  assert.equal((await f.request('api/session',{}, {method:'GET',cookie})).body.signedIn,false);
 }finally{f.close();}
});
test('native contract: tenant isolation, retained history and CAS refuse stale writes',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('alpha'))).body,b=(await f.request('register',account('bravo'))).body,id=crypto.randomUUID();
  const e=envelope(id,1),r=await f.request('upload',{id,expectedRevision:0,envelope:e},{token:a.token});assert.equal(r.status,200);assert.equal(r.body.digest,await digest(JSON.stringify(e)));
  assert.equal((await f.request('download',{id},{token:b.token})).status,404);assert.deepEqual((await f.request('workspaces',{}, {token:b.token})).body.workspaces,[]);
  assert.equal((await f.request('upload',{id,expectedRevision:0,envelope:e},{token:a.token})).status,409);
  const e2=envelope(id,2,'two');assert.equal((await f.request('upload',{id,expectedRevision:1,envelope:e2},{token:a.token})).status,200);
  assert.deepEqual((await f.request('download',{id,revision:1},{token:a.token})).body.envelope,e);
  assert.deepEqual((await f.request('download',{id},{token:a.token})).body.envelope,e2);
  assert.equal((await f.request('workspaces',{}, {token:a.token})).body.workspaces[0].revision,2);
  // SQLite single-statement CAS remains atomic when two async callers arrive.
  f.advance(60001); // Fresh upload-rate window, so this checks CAS rather than throttling.
  const competing=await Promise.all([f.request('upload',{id,expectedRevision:2,envelope:envelope(id,3,'left')},{token:a.token}),f.request('upload',{id,expectedRevision:2,envelope:envelope(id,3,'right')},{token:a.token})]);assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);assert.equal(f.conn.prepare('SELECT count(*) AS n FROM raw_versions WHERE owner=?').get(a.user.id).n,3);
 }finally{f.close();}
});
test('quota failure does not overwrite versions; malformed envelopes and huge body refused',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('quota'))).body,id=crypto.randomUUID(),token=a.token,e=envelope(id,1);
  assert.equal((await f.request('upload',{id,expectedRevision:0,envelope:{...e,iv:'AAAA'}},{token})).status,400);
  assert.equal((await f.request('upload',{id,expectedRevision:0,envelope:e},{token})).status,200);
  f.conn.prepare('UPDATE raw_versions SET bytes=? WHERE owner=?').run(128*1024*1024,a.user.id);
  assert.equal((await f.request('upload',{id,expectedRevision:1,envelope:envelope(id,2)},{token})).status,507);
  assert.equal((await f.request('download',{id},{token})).body.revision,1);
  assert.equal((await f.request('login','x'.repeat(20000))).status,413);
  assert.equal((await f.request('upload',{id,expectedRevision:0,envelope:e},{token,headers:{'Content-Length':String(20*1024*1024)}})).status,413);
  assert.throws(()=>validateEnvelope({...e,tag:e.tag+'='}),/Invalid/);
 }finally{f.close();}
});
test('logout all invalidates other devices; expired sessions rejected; rate limits durable',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('devices'))).body,b=(await f.request('login',account('devices'))).body;
  assert.equal((await f.request('logout-all',{}, {token:a.token})).status,200);assert.equal((await f.request('workspaces',{}, {token:b.token})).status,401);
  const c=(await f.request('login',account('devices'))).body;f.advance(24*3600000+1);assert.equal((await f.request('workspaces',{}, {token:c.token})).status,401);
  const attempts=[];for(let i=0;i<13;i++)attempts.push(await f.request('login',{username:'nobody_'+i,password:secret},{ip:'198.51.100.1'}));assert.equal(attempts.at(-1).status,429);assert.ok(f.conn.prepare('SELECT count(*) n FROM raw_rates').get().n>0);
 }finally{f.close();}
});

test('R2 faults cannot commit missing data, lose committed payloads or leak cross-account keys',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('objects'))).body,token=a.token,id=crypto.randomUUID();
  const put=f.bucket.put;f.bucket.put=async()=>{throw Error('R2 unavailable');};assert.equal((await f.request('upload',{id,expectedRevision:0,envelope:envelope(id,1)},{token})).status,503);assert.equal(f.conn.prepare('SELECT count(*) n FROM raw_versions').get().n,0);
  f.bucket.put=put;assert.equal((await f.request('upload',{id,expectedRevision:0,envelope:envelope(id,1)},{token})).status,200);assert.equal(f.objects.size,1);
  assert.equal((await f.request('upload',{id,expectedRevision:0,envelope:envelope(id,1)},{token})).status,409);assert.equal(f.objects.size,1,'uncommitted CAS loser object removed');
  const prepare=f.db.prepare;let ambiguous=true;f.db.prepare=(q)=>{
   const s=prepare(q);if(!q.startsWith('INSERT INTO raw_versions'))return s;
   const bind=s.bind;s.bind=(...v)=>{const b=bind(...v),run=b.run;b.run=async()=>{const out=await run();if(ambiguous){ambiguous=false;throw Error('receipt transport failed after commit');}return out;};return b;};return s;
  };
  assert.equal((await f.request('upload',{id,expectedRevision:1,envelope:envelope(id,2)},{token})).status,503);assert.equal(f.objects.size,2,'ambiguous but committed object must not be deleted');
  assert.equal((await f.request('download',{id},{token})).body.revision,2);
  const row=f.conn.prepare('SELECT payload FROM raw_versions WHERE revision=2').get();assert.ok(row.payload.startsWith('r2:raw/envelopes/'+a.user.id+'/'));f.objects.set(row.payload.slice(3),'corrupt');assert.equal((await f.request('download',{id},{token})).status,503);
 }finally{f.close();}
});

test('public community preserves unique likes and immutable server-awarded coins; self-rewards denied',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('author'))).body,b=(await f.request('register',account('reader'))).body;
  const post=await f.request('api/community',{action:'post',kind:'preset',title:'Test preset',body:'Shared deliberately',template:{prompt:'Explain my workflow',theme:'operator',shell:'never accepted'}},{token:a.token});assert.equal(post.status,200);const postId=post.body.id;
  assert.equal((await f.request('api/community',{action:'like',postId},{token:a.token})).status,400);
  const actions=await Promise.all([f.request('api/community',{action:'like',postId,coins:9999},{token:b.token}),f.request('api/community',{action:'like',postId},{token:b.token})]);assert.ok(actions.every(r=>r.status===200));
  const ownFeed=await f.request('api/community',{action:'feed'},{token:a.token});assert.equal(ownFeed.body.coins,1);assert.equal(ownFeed.body.posts[0].likes,1);assert.equal(ownFeed.body.posts[0].owned,true);assert.deepEqual(ownFeed.body.posts[0].template,{prompt:'Explain my workflow',theme:'operator'});
  assert.equal(f.conn.prepare('SELECT count(*) n FROM raw_coins').get().n,1);assert.equal((await f.request('api/community',{action:'feed'},{token:b.token})).body.coins,0);
  assert.equal((await f.request('api/community',{action:'report',postId,reason:'Test report'},{token:b.token})).status,200);assert.equal(f.conn.prepare('SELECT count(*) n FROM raw_reports').get().n,1);
  assert.equal((await f.request('api/community',{action:'post',kind:'preset',title:'Bad',body:'Bad',template:{theme:'javascript:alert(1)'}},{token:a.token})).status,400);
  assert.equal((await f.request('api/community',{action:'feed'})).status,401);
 }finally{f.close();}
});

test('private groups require membership and explicit invite; departed and removed members lose access',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('leader'))).body,b=(await f.request('register',account('member'))).body,c=(await f.request('register',account('outsider'))).body;
  const created=await f.request('api/groups',{action:'create',name:'Test party'},{token:a.token});assert.equal(created.status,200);const groupId=created.body.group.id,inviteCode=created.body.inviteCode;assert.match(inviteCode,/^[A-Za-z0-9_-]{32}$/);
  assert.equal((await f.request('api/groups',{action:'remove',groupId,username:'LEADER'},{token:a.token})).status,403);assert.equal((await f.request('api/groups',{action:'list'},{token:a.token})).body.groups.length,1);
  assert.equal((await f.request('api/groups',{action:'messages',groupId},{token:c.token})).status,404);
  assert.equal((await f.request('api/groups',{action:'send',groupId,body:'No access'},{token:b.token})).status,404);
  assert.equal((await f.request('api/groups',{action:'join',inviteCode},{token:b.token})).status,200);
  assert.equal((await f.request('api/groups',{action:'invite',groupId},{token:b.token})).status,403);
  assert.equal((await f.request('api/groups',{action:'send',groupId,body:'Hello'},{token:b.token})).status,200);
  assert.equal((await f.request('api/groups',{action:'messages',groupId},{token:a.token})).body.messages[0].username,'member');
  const rotated=await f.request('api/groups',{action:'invite',groupId},{token:a.token});assert.equal(rotated.status,200);assert.equal((await f.request('api/groups',{action:'join',inviteCode},{token:c.token})).status,404);
  assert.equal((await f.request('api/groups',{action:'remove',groupId,username:'member'},{token:a.token})).status,200);assert.equal((await f.request('api/groups',{action:'messages',groupId},{token:b.token})).status,404);
  assert.equal((await f.request('api/groups',{action:'join',inviteCode:rotated.body.inviteCode},{token:b.token})).status,200);
  assert.equal((await f.request('api/groups',{action:'leave',groupId},{token:b.token})).status,200);assert.equal((await f.request('api/groups',{action:'messages',groupId},{token:b.token})).status,404);
  const stored=f.conn.prepare('SELECT invite_digest FROM raw_groups WHERE id=?').get(groupId);assert.notEqual(stored.invite_digest,rotated.body.inviteCode);
 }finally{f.close();}
});

test('operator key gates moderation and global announcements without granting any private vault access',async()=>{
 const key='K'.repeat(43),f=fixture({operatorKey:key});try{
  const a=(await f.request('register',account('moderation'))).body,token=a.token;
  const posted=await f.request('api/community',{action:'post',kind:'forum',title:'Test',body:'Public only'},{token});const postId=posted.body.id;
  assert.equal((await f.request('api/operator',{action:'announce',title:'No',body:'No'},{token})).status,403);
  const headers={'X-Raw-Operator':key};assert.equal((await f.request('api/operator',{action:'announce',title:'Beta update',body:'Version tested',version:'0.34.0'},{headers})).status,200);
  const announcements=await f.request('api/announcements',{}, {token});assert.equal(announcements.body.announcements[0].title,'Beta update');assert.equal(JSON.stringify(announcements.body).includes(key),false);
  assert.equal((await f.request('api/operator',{action:'hide-post',postId},{headers})).status,200);assert.equal((await f.request('api/community',{action:'feed'},{token})).body.posts.length,0);
  assert.equal((await f.request('api/operator',{action:'restore-post',postId},{headers})).status,200);assert.equal((await f.request('api/community',{action:'feed'},{token})).body.posts.length,1);
  assert.equal((await f.request('api/operator',{action:'download',id:crypto.randomUUID()},{headers})).status,400);
  assert.equal((await f.request('download',{id:crypto.randomUUID()},{headers})).status,401);
  assert.equal((await f.request('api/operator',{action:'audit'},{headers})).body.audit.length,3);
 }finally{f.close();}
 const unconfigured=fixture();try{assert.equal((await unconfigured.request('api/operator',{action:'reports'},{headers:{'X-Raw-Operator':key}})).status,503);}finally{unconfigured.close();}
});

test('voice signaling only reaches consenting current group peers and expires promptly',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('voice_a'))).body,b=(await f.request('register',account('voice_b'))).body,c=(await f.request('register',account('voice_c'))).body;
  const group=(await f.request('api/groups',{action:'create',name:'Voice QA'},{token:a.token})).body,groupId=group.group.id;
  await f.request('api/groups',{action:'join',inviteCode:group.inviteCode},{token:b.token});
  assert.equal((await f.request('api/voice',{action:'join',groupId},{token:c.token})).status,404);
  const offer={type:'offer',sdp:'v=0\r\nTest SDP'};assert.equal((await f.request('api/voice',{action:'signal',groupId,target:b.user.id,kind:'offer',data:offer},{token:a.token})).status,409);
  assert.equal((await f.request('api/voice',{action:'join',groupId},{token:a.token})).status,200);assert.equal((await f.request('api/voice',{action:'join',groupId},{token:b.token})).status,200);
  assert.equal((await f.request('api/voice',{action:'signal',groupId,target:b.user.id,kind:'offer',data:offer},{token:a.token})).status,200);
  const poll=await f.request('api/voice',{action:'poll',groupId},{token:b.token});assert.equal(poll.body.signals[0].sender,a.user.id);assert.deepEqual(poll.body.signals[0].data,offer);assert.equal(poll.body.peers.length,2);
  assert.equal((await f.request('api/voice',{action:'poll',groupId},{token:a.token})).body.signals.length,0);
  await f.request('api/groups',{action:'remove',groupId,username:'voice_b'},{token:a.token});assert.equal((await f.request('api/voice',{action:'poll',groupId},{token:b.token})).status,404);
  assert.equal((await f.request('api/voice',{action:'signal',groupId,target:b.user.id,kind:'answer',data:{type:'answer',sdp:'v=0'}},{token:a.token})).status,409);
  f.advance(45001);assert.equal((await f.request('api/voice',{action:'heartbeat',groupId},{token:a.token})).status,409);
  f.advance(120001);await f.request('api/voice',{action:'join',groupId},{token:a.token});assert.equal(f.conn.prepare('SELECT count(*) n FROM raw_voice_signals').get().n,0);
 }finally{f.close();}
});

test('friendly challenges are live by default; coin stakes stay disabled and outcomes need both players',async()=>{
 const f=fixture();try{
  const a=(await f.request('register',account('challenger'))).body,b=(await f.request('register',account('challenged'))).body,c=(await f.request('register',account('spectator'))).body;
  assert.equal((await f.request('api/challenges',{action:'create',username:'challenged',title:'Test race',stake:1},{token:a.token})).status,400);
  const created=await f.request('api/challenges',{action:'create',username:'challenged',title:'Test race',stake:0},{token:a.token});assert.equal(created.status,200);const challengeId=created.body.id;
  assert.equal((await f.request('api/challenges',{action:'accept',challengeId},{token:c.token})).status,404);
  assert.equal((await f.request('api/challenges',{action:'accept',challengeId},{token:b.token})).status,200);
  assert.equal((await f.request('api/challenges',{action:'propose',challengeId,winner:a.user.id},{token:a.token})).status,200);
  assert.equal((await f.request('api/challenges',{action:'confirm',challengeId,winner:a.user.id,confirm:'CONFIRM RESULT'},{token:a.token})).status,403);
  assert.equal((await f.request('api/challenges',{action:'confirm',challengeId,winner:a.user.id,confirm:'CONFIRM RESULT'},{token:b.token})).status,200);
  const list=await f.request('api/challenges',{action:'list'},{token:a.token});assert.equal(list.body.coinStakesEnabled,false);assert.equal(list.body.challenges[0].state,'settled');assert.equal(list.body.coins,0);
 }finally{f.close();}
});

test('fixture-only coin escrow conserves coins, pays once, preserves changed-result review and refunds expiry',async()=>{
 const f=fixture({allowCoinChallenges:true});try{
  const a=(await f.request('register',account('coin_a'))).body,b=(await f.request('register',account('coin_b'))).body;
  for(const u of[a,b])f.conn.prepare('INSERT INTO raw_coins(event,owner,delta,created) VALUES(?,?,100,?)').run('fixture:'+u.user.id,u.user.id,Date.now());
  const created=await f.request('api/challenges',{action:'create',username:'coin_b',title:'Agreed test',stake:10},{token:a.token}),challengeId=created.body.id;assert.equal(created.status,200);
  assert.equal((await f.request('api/challenges',{action:'accept',challengeId},{token:b.token})).status,200);assert.equal(f.conn.prepare('SELECT sum(delta) n FROM raw_coins').get().n,180);
  await f.request('api/challenges',{action:'propose',challengeId,winner:a.user.id},{token:a.token});await f.request('api/challenges',{action:'propose',challengeId,winner:b.user.id},{token:a.token});
  assert.equal((await f.request('api/challenges',{action:'confirm',challengeId,winner:a.user.id,confirm:'CONFIRM RESULT'},{token:b.token})).status,409);
  assert.equal((await f.request('api/challenges',{action:'confirm',challengeId,winner:b.user.id,confirm:'CONFIRM RESULT'},{token:b.token})).status,200);assert.equal((await f.request('api/challenges',{action:'confirm',challengeId,winner:b.user.id,confirm:'CONFIRM RESULT'},{token:b.token})).status,200);assert.equal(f.conn.prepare('SELECT sum(delta) n FROM raw_coins').get().n,200);
  const cancelled=(await f.request('api/challenges',{action:'create',username:'coin_b',title:'Declined test',stake:20},{token:a.token})).body.id;assert.equal((await f.request('api/challenges',{action:'cancel',challengeId:cancelled},{token:b.token})).status,200);assert.equal(f.conn.prepare('SELECT sum(delta) n FROM raw_coins').get().n,200);
  const expires=(await f.request('api/challenges',{action:'create',username:'coin_b',title:'Expiry test',stake:20},{token:a.token})).body.id;await f.request('api/challenges',{action:'accept',challengeId:expires},{token:b.token});assert.equal(f.conn.prepare('SELECT sum(delta) n FROM raw_coins').get().n,160);
  f.advance(7*86400000+1);const newA=(await f.request('login',account('coin_a'))).body;await f.request('api/challenges',{action:'list'},{token:newA.token});assert.equal(f.conn.prepare('SELECT sum(delta) n FROM raw_coins').get().n,200);assert.equal(f.conn.prepare('SELECT state FROM raw_challenges WHERE id=?').get(expires).state,'expired-active');
 }finally{f.close();}
});
