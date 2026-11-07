export type VoiceView = {
  phase:"idle"|"joining"|"live"|"error";
  muted:boolean;
  peers:{id:string;username:string;state:string}[];
  message:string;
};
type Peer = {pc:RTCPeerConnection;name:string;pending:RTCIceCandidateInit[];makingOffer:boolean;ignoreOffer:boolean;settingAnswer:boolean;offered:boolean;created:number;timer:ReturnType<typeof setTimeout>|null};
type Options = {
  request?:(body:Record<string,unknown>,signal:AbortSignal)=>Promise<any>;
  getUserMedia?:()=>Promise<MediaStream>;
  createPeer?:(config:RTCConfiguration)=>RTCPeerConnection;
  createStream?:(tracks:MediaStreamTrack[])=>MediaStream;
  onView?:(view:VoiceView)=>void;
  onRemote?:(id:string,stream:MediaStream)=>void;
  onRemoteRemoved?:(id:string)=>void;
  now?:()=>number;
  setTimer?:typeof setTimeout;
  clearTimer?:typeof clearTimeout;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const VOICE_STUN="stun:stun.cloudflare.com:3478";
export async function voiceRequest(body:Record<string,unknown>,signal:AbortSignal) {
 const r=await fetch("/api/voice",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",redirect:"error",body:JSON.stringify(body),signal});
 const reader=r.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
 try {if(reader)for(;;){const row=await reader.read();if(row.done)break;size+=row.value.length;if(size>1024*1024){await reader.cancel();throw Error("Voice response exceeded the limit.");}chunks.push(row.value);}}finally{reader?.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length;}let value;
 try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error("Voice service returned an invalid response.");}
 if(!r.ok)throw Object.assign(Error(typeof value.error==="string"?value.error.slice(0,240):"Voice request failed."),{status:r.status});return value;
}

// Media starts only in join(), which the React component calls from the explicit
// Join button. Dependencies are injectable for synthetic tests, never from URLs.
export class VoiceClient {
 readonly groupId:string;
 view:VoiceView={phase:"idle",muted:false,peers:[],message:"Microphone off."};
 private options:Options;
 private epoch=0;
 private self="";
 private stream:MediaStream|null=null;
 private peers=new Map<string,Peer>();
 private remote=new Map<string,MediaStream>();
 private requests=new Set<AbortController>();
 private pollTimer:ReturnType<typeof setTimeout>|null=null;
 private heartbeatTimer:ReturnType<typeof setTimeout>|null=null;
 private lastSignal=0;
 private leaseUntil=0;
 private maybeJoined=false;
 private leaving:Promise<void>=Promise.resolve();
 private polling=false;
 private ended=new Map<MediaStreamTrack,()=>void>();
 constructor(groupId:string,options:Options={}) {if(!UUID.test(groupId))throw Error("Invalid group.");this.groupId=groupId;this.options=options;}
 private now() {return (this.options.now||Date.now)();}
 private timer(fn:()=>void,ms:number) {return (this.options.setTimer||setTimeout)(fn,ms);}
 private clear(timer:ReturnType<typeof setTimeout>|null) {if(timer!==null)(this.options.clearTimer||clearTimeout)(timer);}
 private current(epoch:number) {return this.epoch===epoch&&(this.view.phase==="joining"||this.view.phase==="live");}
 private publish() {this.view={...this.view,peers:[...this.peers].map(([id,p])=>({id,username:p.name,state:p.pc.connectionState||"connecting"}))};this.options.onView?.({...this.view,peers:this.view.peers.map(p=>({...p}))});}
 private async request(action:string,data:Record<string,unknown>,epoch:number) {
  if(!this.current(epoch))throw Error("Voice session ended.");const controller=new AbortController();this.requests.add(controller);const timeout=this.timer(()=>controller.abort(),10000);
  try {const value=await (this.options.request||voiceRequest)({action,groupId:this.groupId,...data},controller.signal);if(!this.current(epoch))throw Error("Voice session ended.");return value;}
  finally {this.clear(timeout);this.requests.delete(controller);}
 }
 async join() {
  if(this.view.phase==="joining"||this.view.phase==="live")return false;
  const epoch=++this.epoch;this.view={phase:"joining",muted:false,peers:[],message:"Allow your microphone to join voice."};this.publish();
  try {
   await this.leaving;if(!this.current(epoch))return false;
   const stream=await (this.options.getUserMedia||(()=>{if(typeof navigator==="undefined"||!navigator.mediaDevices?.getUserMedia)throw Error("Microphone access is unavailable. Use HTTPS and a supported browser.");return navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});}))();
   if(!this.current(epoch)){for(const t of stream.getTracks())t.stop();return false;}
   if(!stream.getAudioTracks().length||stream.getTracks().some(t=>t.kind!=="audio"||t.readyState==="ended")){for(const t of stream.getTracks())t.stop();throw Error("Voice needs an active audio-only microphone stream.");}
   this.stream=stream;for(const t of stream.getTracks()){const ended=()=>{if(this.current(epoch))this.stop("Microphone stopped. Join again when you are ready.",true);};this.ended.set(t,ended);t.addEventListener("ended",ended);}
   // Clear this account's stale signaling after a previous crashed page. This is
   // our own presence only and cannot withdraw another member's microphone.
   this.maybeJoined=true;await this.request("leave",{},epoch);const started=this.now(),r=await this.request("join",{},epoch);
   if(!UUID.test(r.self))throw Error("Voice service returned an invalid participant.");this.self=r.self;this.lastSignal=0;this.leaseUntil=started+40000;
   this.view={...this.view,phase:"live",message:"Microphone live. Waiting for your group."};this.publish();
   this.scheduleHeartbeat(epoch);await this.poll(epoch);return this.current(epoch);
  } catch(error) {if(this.current(epoch))this.stop(this.message(error),true);return false;}
 }
 private message(error:unknown) {const e=error as Error;return e?.name==="NotAllowedError"?"Microphone permission was not granted. You are not in voice.":e?.name==="NotFoundError"?"No microphone was found.":e?.name==="AbortError"?"Voice connection timed out. Your microphone is off.":(e?.message||"Voice stopped. Please join again.").slice(0,240);}
 private scheduleHeartbeat(epoch:number) {this.heartbeatTimer=this.timer(()=>{this.heartbeatTimer=null;void this.heartbeat(epoch);},20000);}
 private async heartbeat(epoch:number) {
  if(!this.current(epoch))return;
  try {if(this.now()>=this.leaseUntil)throw Error("Voice session expired. Your microphone is off.");const started=this.now();await this.request("heartbeat",{},epoch);if(!this.current(epoch))return;this.leaseUntil=started+40000;this.scheduleHeartbeat(epoch);}
  catch(error){if(this.current(epoch))this.stop(this.message(error),true);}
 }
 private assertLease() {if(this.now()>=this.leaseUntil)throw Error("Voice session expired. Your microphone is off.");}
 private async send(peerId:string,kind:string,data:unknown,epoch:number) {this.assertLease();await this.request("signal",{target:peerId,kind,data},epoch);}
 private peer(peerId:string,name:string,epoch:number) {
  const old=this.peers.get(peerId);if(old){old.name=name;return old;}
  if(this.peers.size>=3||!this.stream)throw Error("Voice participant limit reached.");
  const pc=(this.options.createPeer||(config=>new RTCPeerConnection(config)))({iceServers:[{urls:VOICE_STUN}],bundlePolicy:"max-bundle",iceCandidatePoolSize:0});
  const peer:Peer={pc,name,pending:[],makingOffer:false,ignoreOffer:false,settingAnswer:false,offered:false,created:this.now(),timer:null};this.peers.set(peerId,peer);
  for(const track of this.stream.getAudioTracks())pc.addTrack(track,this.stream);
  pc.onicecandidate=event=>{if(!event.candidate||!this.current(epoch)||this.peers.get(peerId)!==peer)return;const data=event.candidate.toJSON();void this.send(peerId,"ice",data,epoch).catch(error=>{if(this.current(epoch)&&this.peers.get(peerId)===peer)this.stop(this.message(error),true);});};
  pc.ontrack=event=>{if(!this.current(epoch)||this.peers.get(peerId)!==peer||event.track.kind!=="audio"||this.remote.get(peerId)?.getAudioTracks().some(t=>t!==event.track&&t.readyState!=="ended")){event.track.stop();return;}const stream=(this.options.createStream||(tracks=>new MediaStream(tracks)))([event.track]);this.remote.set(peerId,stream);this.options.onRemote?.(peerId,stream);};
  pc.onconnectionstatechange=()=>{if(!this.current(epoch)||this.peers.get(peerId)!==peer)return;if(pc.connectionState==="connected"){this.clear(peer.timer);peer.timer=null;this.view={...this.view,message:"Voice connected."};}
   else if(pc.connectionState==="failed") {this.stop("Voice could not connect on this network. Your microphone is off.",true);return;}
   else if(pc.connectionState==="disconnected") {this.clear(peer.timer);peer.timer=this.timer(()=>{peer.timer=null;if(this.current(epoch)&&this.peers.get(peerId)===peer&&pc.connectionState!=="connected")this.stop("Voice connection was lost. Your microphone is off.",true);},10000);}this.publish();};
  peer.timer=this.timer(()=>{peer.timer=null;if(this.current(epoch)&&this.peers.get(peerId)===peer&&pc.connectionState!=="connected")this.stop("Voice could not connect on this network. Your microphone is off.",true);},30000);
  return peer;
 }
 private async offer(peerId:string,peer:Peer,epoch:number) {
  if(peer.makingOffer||peer.pc.signalingState!=="stable")return;peer.makingOffer=true;peer.offered=true;
  try {const offer=await peer.pc.createOffer();if(!this.current(epoch)||this.peers.get(peerId)!==peer)return;await peer.pc.setLocalDescription(offer);if(!this.current(epoch)||this.peers.get(peerId)!==peer)return;await this.send(peerId,"offer",peer.pc.localDescription?.toJSON()||offer,epoch);}
  finally {peer.makingOffer=false;}
 }
 private async signal(signal:any,peer:Peer,epoch:number) {
  const pc=peer.pc;
  if(signal.kind==="ice") {if(!pc.remoteDescription){if(peer.pending.length>=100)throw Error("Too many pending voice candidates.");peer.pending.push(signal.data);return;}
   try {await pc.addIceCandidate(signal.data);}catch(error){if(!peer.ignoreOffer)throw error;}return;}
  if(signal.kind!=="offer"&&signal.kind!=="answer")throw Error("Invalid voice signal.");
  const offer=signal.kind==="offer",ready=!peer.makingOffer&&(pc.signalingState==="stable"||peer.settingAnswer),collision=offer&&!ready;
  peer.ignoreOffer=collision&&this.self<signal.sender;if(peer.ignoreOffer)return;
  peer.settingAnswer=!offer;
  try {if(collision&&pc.signalingState!=="stable")await pc.setLocalDescription({type:"rollback"});if(!this.current(epoch)||this.peers.get(signal.sender)!==peer)return;await pc.setRemoteDescription(signal.data);}
  finally {peer.settingAnswer=false;}
  if(!this.current(epoch)||this.peers.get(signal.sender)!==peer)return;
  const candidates=peer.pending.splice(0);for(const c of candidates){await pc.addIceCandidate(c);if(!this.current(epoch))return;}
  if(offer){const answer=await pc.createAnswer();if(!this.current(epoch))return;await pc.setLocalDescription(answer);if(!this.current(epoch))return;await this.send(signal.sender,"answer",pc.localDescription?.toJSON()||answer,epoch);}
 }
 private async poll(epoch:number) {
  if(!this.current(epoch)||this.polling)return;this.polling=true;
  try {
   this.assertLease();const r=await this.request("poll",{after:this.lastSignal},epoch);if(!this.current(epoch))return;
   if(r.self!==this.self||!Array.isArray(r.peers)||r.peers.length>4||!Array.isArray(r.signals)||r.signals.length>100)throw Error("Voice service returned an invalid session.");
   const live=new Map<string,string>();for(const p of r.peers){if(!UUID.test(p.id)||typeof p.username!=="string"||p.username.length>32)throw Error("Invalid voice participant.");if(live.has(p.id))throw Error("Invalid duplicate voice participant.");live.set(p.id,p.username);}
   if(!live.has(this.self))throw Error("Your voice session ended. Your microphone is off.");
   for(const peerId of this.peers.keys())if(!live.has(peerId))this.dropPeer(peerId);
   for(const [peerId,name]of live)if(peerId!==this.self)this.peer(peerId,name,epoch);
   for(const row of r.signals){if(!Number.isSafeInteger(row.id)||row.id<=0||typeof row.sender!=="string")throw Error("Invalid voice signal.");if(row.id<=this.lastSignal)continue;const peer=this.peers.get(row.sender);if(peer)await this.signal(row,peer,epoch);if(!this.current(epoch))return;this.lastSignal=row.id;}
   for(const [peerId,peer]of this.peers){if(!peer.offered&&!peer.pc.remoteDescription&&(this.self<peerId||this.now()-peer.created>=8000))await this.offer(peerId,peer,epoch);if(!this.current(epoch))return;}
   this.publish();
  }catch(error){if(this.current(epoch))this.stop(this.message(error),true);}
  finally {if(this.epoch===epoch)this.polling=false;if(this.current(epoch))this.pollTimer=this.timer(()=>{this.pollTimer=null;void this.poll(epoch);},2500);}
 }
 private dropPeer(peerId:string) {
  const peer=this.peers.get(peerId);this.peers.delete(peerId);if(peer){this.clear(peer.timer);peer.pc.onicecandidate=null;peer.pc.ontrack=null;peer.pc.onconnectionstatechange=null;for(const receiver of peer.pc.getReceivers())receiver.track?.stop();peer.pc.close();peer.pending.length=0;}
  const stream=this.remote.get(peerId);if(stream){for(const t of stream.getTracks())t.stop();this.remote.delete(peerId);}this.options.onRemoteRemoved?.(peerId);
 }
 mute(muted:boolean) {if(this.view.phase!=="live")return;for(const t of this.stream?.getAudioTracks()||[])t.enabled=!muted;this.view={...this.view,muted};this.publish();}
 stop(message="Microphone off.",failed=false) {
  const wasJoined=this.maybeJoined;this.maybeJoined=false;++this.epoch;this.clear(this.pollTimer);this.clear(this.heartbeatTimer);this.pollTimer=null;this.heartbeatTimer=null;
  for(const r of this.requests)r.abort();this.requests.clear();for(const [t,fn]of this.ended)t.removeEventListener("ended",fn);this.ended.clear();for(const t of this.stream?.getTracks()||[])t.stop();this.stream=null;
  for(const peerId of [...this.peers.keys()])this.dropPeer(peerId);this.remote.clear();this.self="";this.lastSignal=0;this.leaseUntil=0;this.polling=false;
  this.view={phase:failed?"error":"idle",muted:false,peers:[],message};this.publish();
  if(wasJoined){const controller=new AbortController(),timeout=this.timer(()=>controller.abort(),2000);this.leaving=(this.options.request||voiceRequest)({action:"leave",groupId:this.groupId},controller.signal).then(()=>{},()=>{}).finally(()=>this.clear(timeout));}
 }
}
