import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceClient,VOICE_STUN,voiceRequest} from '../browser/voice-client.ts';
const group='11111111-1111-4111-8111-111111111111',self='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
class Track extends EventTarget{kind='audio';enabled=true;stopped=false;stop(){this.stopped=true;}end(){this.dispatchEvent(new Event('ended'));}}
class Stream {constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}}
const description=v=>({...v,toJSON(){return {...v};}});
class Peer {
 signalingState='stable';connectionState='new';localDescription=null;remoteDescription=null;tracks=[];candidates=[];closed=false;received=new Track();
 addTrack(t){this.tracks.push(t);}
 async createOffer(){return{type:'offer',sdp:'v=0\r\nsynthetic offer'};}
 async createAnswer(){return{type:'answer',sdp:'v=0\r\nsynthetic answer'};}
 async setLocalDescription(d){if(this.closed)throw Error('closed');this.localDescription=description(d);this.signalingState=d.type==='offer'?'have-local-offer':'stable';}
 async setRemoteDescription(d){if(this.closed)throw Error('closed');if(d.type==='answer'&&this.signalingState!=='have-local-offer')throw Error('answer without local offer');this.remoteDescription=description(d);this.signalingState=d.type==='offer'?'have-remote-offer':'stable';}
 async addIceCandidate(c){if(!this.remoteDescription)throw Error('missing description');this.candidates.push(c);}
 getReceivers(){return[{track:this.received}];}
 close(){this.closed=true;this.connectionState='closed';}
 connect(){this.connectionState='connected';this.onconnectionstatechange?.();}
 disconnect(){this.connectionState='disconnected';this.onconnectionstatechange?.();}
}
function fixture(overrides={}) {
 let now=100000,id=0,microphones=0;const timers=new Map(),requests=[],views=[],pcs=[],remote=[],removed=[];
 const track=new Track(),stream=new Stream([track]);
 const state={self,peers:[{id:self,username:'alice'},{id:other,username:'bob'}],signals:[],fail:null};
 const request=async(a,signal)=>{requests.push({...a,signal});if(state.fail&&a.action===state.fail.action)throw Object.assign(Error(state.fail.message||'Membership revoked.'),{status:state.fail.status||404});if(a.action==='join')return{joined:true,self:state.self};if(a.action==='poll')return{self:state.self,peers:state.peers,signals:state.signals.filter(s=>s.id>(a.after||0))};return{ok:true};};
 const client=new VoiceClient(group,{request,getUserMedia:async()=>{microphones++;return stream;},createPeer:config=>{assert.deepEqual(config.iceServers,[{urls:VOICE_STUN}]);const pc=new Peer();pcs.push(pc);return pc;},createStream:tracks=>new Stream(tracks),onView:v=>views.push(v),onRemote:(id,stream)=>remote.push({id,stream}),onRemoteRemoved:id=>removed.push(id),now:()=>now,setTimer:(fn,ms)=>{const current=++id;timers.set(current,{fn,at:now+ms});return current;},clearTimer:id=>timers.delete(id),...overrides});
 async function tick(ms){now+=ms;const due=[...timers].filter(([,v])=>v.at<=now).sort((a,b)=>a[1].at-b[1].at);for(const [id,v]of due){if(!timers.has(id))continue;timers.delete(id);v.fn();await flush();}}
 return{client,state,track,stream,pcs,requests,views,remote,removed,timers,tick,flush,get microphones(){return microphones;}};
}

test('no microphone or network is used before explicit join; mute and leave release all resources',async()=>{
 const f=fixture();assert.equal(f.microphones,0);assert.equal(f.requests.length,0);
 assert.equal(await f.client.join(),true);assert.equal(f.microphones,1);assert.equal(f.client.view.phase,'live');assert.deepEqual(f.requests.slice(0,3).map(r=>r.action),['leave','join','poll']);assert.equal(f.pcs.length,1);assert.ok(f.requests.some(r=>r.action==='signal'&&r.kind==='offer'));
 f.client.mute(true);assert.equal(f.track.enabled,false);assert.equal(f.client.view.muted,true);f.client.mute(false);assert.equal(f.track.enabled,true);
 f.pcs[0].connect();f.pcs[0].ontrack({track:f.pcs[0].received,streams:[new Stream([f.pcs[0].received])]});assert.equal(f.remote.length,1);
 f.client.stop();await flush();assert.equal(f.track.stopped,true);assert.equal(f.pcs[0].closed,true);assert.equal(f.pcs[0].received.stopped,true);assert.ok(f.removed.includes(other));assert.equal(f.client.view.phase,'idle');assert.equal(f.timers.size,0);assert.equal(f.requests.at(-1).action,'leave');
});
test('cancelling while microphone permission is pending stops every late track and never joins',async()=>{
 const d=deferred(),f=fixture({getUserMedia:()=>d.promise});const joining=f.client.join();await flush();f.client.stop();d.resolve(f.stream);assert.equal(await joining,false);assert.equal(f.track.stopped,true);assert.equal(f.requests.length,0);assert.equal(f.client.view.phase,'idle');
});
test('permission denial leaves voice stopped and does not start presence or retry',async()=>{
 const f=fixture({getUserMedia:async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});}});assert.equal(await f.client.join(),false);assert.equal(f.requests.length,0);assert.equal(f.client.view.phase,'error');assert.match(f.client.view.message,/permission/);assert.equal(f.timers.size,0);
});
test('server join failure stops microphone immediately and attempts bounded presence cleanup',async()=>{
 const f=fixture();f.state.fail={action:'join',status:409,message:'Voice is full.'};assert.equal(await f.client.join(),false);await flush();assert.equal(f.track.stopped,true);assert.equal(f.client.view.phase,'error');assert.match(f.client.view.message,/full/);assert.equal(f.pcs.length,0);assert.equal(f.requests.at(-1).action,'leave');assert.equal(f.timers.size,0);
});
test('stop during an outstanding join discards the late session and aborts its request',async()=>{
 const d=deferred(),seen=[],f=fixture({request:async(a,signal)=>{seen.push({a,signal});return a.action==='join'?d.promise:{ok:true};}});const joining=f.client.join();await flush();const pending=seen.find(r=>r.a.action==='join');assert.ok(pending);f.client.stop();assert.equal(pending.signal.aborted,true);d.resolve({self,joined:true});assert.equal(await joining,false);assert.equal(f.track.stopped,true);assert.equal(f.pcs.length,0);assert.equal(f.client.view.phase,'idle');
});
test('ICE received before the answer is buffered then applied after the remote description',async()=>{
 const f=fixture();assert.equal(await f.client.join(),true);f.state.signals=[{id:1,sender:other,kind:'ice',data:{candidate:'candidate:qa',sdpMid:'0',sdpMLineIndex:0}},{id:2,sender:other,kind:'answer',data:{type:'answer',sdp:'v=0\r\nanswer'}}];await f.tick(2500);assert.equal(f.pcs[0].candidates.length,1);assert.equal(f.pcs[0].remoteDescription.type,'answer');f.client.stop();await flush();
});
test('higher-ID participant answers an offer, without a competing initial offer',async()=>{
 const f=fixture();f.state.self=other;f.state.peers=[{id:self,username:'alice'},{id:other,username:'bob'}];f.state.signals=[{id:1,sender:self,kind:'offer',data:{type:'offer',sdp:'v=0\r\noffer'}}];assert.equal(await f.client.join(),true);const signals=f.requests.filter(r=>r.action==='signal');assert.equal(signals.filter(r=>r.kind==='offer').length,0);assert.equal(signals.filter(r=>r.kind==='answer').length,1);f.client.stop();await flush();
});
test('removed peer closes its connection and remote tracks on the next poll',async()=>{
 const f=fixture();await f.client.join();f.pcs[0].connect();f.state.peers=[{id:self,username:'alice'}];await f.tick(2500);assert.equal(f.pcs[0].closed,true);assert.equal(f.pcs[0].received.stopped,true);assert.equal(f.client.view.peers.length,0);assert.equal(f.track.stopped,false);f.client.stop();await flush();
});
test('membership revocation and network failure fail closed, stopping microphone and every peer',async()=>{
 for(const status of[401,404,409,503]){const f=fixture();await f.client.join();f.state.fail={action:'poll',status};await f.tick(2500);assert.equal(f.track.stopped,true);assert.equal(f.pcs[0].closed,true);assert.equal(f.client.view.phase,'error');await flush();assert.equal(f.timers.size,0);}
});
test('expired lease after a suspended timer stops capture before another request',async()=>{
 const f=fixture();await f.client.join();const requests=f.requests.length;await f.tick(45000);assert.equal(f.track.stopped,true);assert.equal(f.client.view.phase,'error');assert.match(f.client.view.message,/expired/);assert.ok(f.requests.slice(requests).every(r=>r.action==='leave'));await flush();
});
test('failed connection, missing peer and microphone-ended events stop capture',async()=>{
 {const f=fixture();await f.client.join();await f.tick(30000);assert.equal(f.track.stopped,true);assert.match(f.client.view.message,/connect/);await flush();}
 {const f=fixture();f.state.peers=[{id:other,username:'bob'}];assert.equal(await f.client.join(),false);assert.equal(f.track.stopped,true);await flush();}
 {const f=fixture();await f.client.join();f.track.end();assert.equal(f.track.stopped,true);assert.equal(f.pcs[0].closed,true);await flush();}
});
test('connection drop gets a bounded recovery window and then releases the microphone',async()=>{
 const f=fixture();await f.client.join();f.pcs[0].connect();f.pcs[0].disconnect();await f.tick(10000);assert.equal(f.track.stopped,true);assert.match(f.client.view.message,/lost/);await flush();
});
test('remote video tracks are refused and no local video is ever requested',async()=>{
 const f=fixture();await f.client.join();const video=new Track();video.kind='video';f.pcs[0].ontrack({track:video,streams:[]});assert.equal(video.stopped,true);assert.equal(f.remote.length,0);assert.ok(f.pcs[0].tracks.every(t=>t.kind==='audio'));f.pcs[0].ontrack({track:f.pcs[0].received,streams:[]});const extra=new Track();f.pcs[0].ontrack({track:extra,streams:[]});assert.equal(extra.stopped,true);assert.equal(f.remote.length,1,'one remote audio track is allowed per person');f.client.stop();await flush();
});
test('voice fetch keeps cookies same-origin, rejects redirects, sends no secret or provider key',async()=>{
 const previous=globalThis.fetch;try{let options;globalThis.fetch=async(url,o)=>{assert.equal(url,'/api/voice');options=o;return Response.json({joined:true,self});};const value=await voiceRequest({action:'join',groupId:group},new AbortController().signal);assert.equal(value.self,self);assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.deepEqual(Object.keys(options.headers),['Content-Type']);
 globalThis.fetch=async()=>Response.json({error:'Sign in to continue.'},{status:401});await assert.rejects(voiceRequest({action:'poll'},new AbortController().signal),/Sign in/);
 }finally{globalThis.fetch=previous;}
});
