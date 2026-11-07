"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {VoiceClient,type VoiceView} from "./voice-client";

const initial:VoiceView={phase:"idle",muted:false,peers:[],message:"Microphone off."};
function PartyAudio({id,stream,session,register,onBlocked}:{id:string;stream:MediaStream;session:string;register:(id:string,element:HTMLAudioElement|null,previous?:HTMLAudioElement)=>void;onBlocked:(id:string,element:HTMLAudioElement)=>void}) {
 const audio=useRef<HTMLAudioElement|null>(null);
 useEffect(()=>{const element=audio.current;if(!element)return;let active=true;register(id,element);element.srcObject=stream;void element.play().catch(()=>{if(active)onBlocked(id,element);});return()=>{active=false;element.pause();element.srcObject=null;register(id,null,element);};},[id,stream,session,register,onBlocked]);
 return <audio ref={audio} autoPlay playsInline aria-label="Group audio"/>;
}
export default function VoiceParty({groupId,sessionKey=""}:{groupId:string;sessionKey?:string}) {
 const client=useRef<VoiceClient|null>(null),mounted=useRef(false);
 const [view,setView]=useState<VoiceView>(initial),[remote,setRemote]=useState<Record<string,MediaStream>>({}),[blocked,setBlocked]=useState(false);
 const audio=useRef(new Map<string,HTMLAudioElement>());
 const register=useCallback((id:string,element:HTMLAudioElement|null,previous?:HTMLAudioElement)=>{if(element)audio.current.set(id,element);else if(audio.current.get(id)===previous)audio.current.delete(id);},[]);
 const playbackBlocked=useCallback((id:string,element:HTMLAudioElement)=>{if(mounted.current&&audio.current.get(id)===element)setBlocked(true);},[]);
 useEffect(()=>{
  mounted.current=true;setView(initial);setRemote({});setBlocked(false);
  const current=new VoiceClient(groupId,{onView:v=>{if(mounted.current)setView(v);},onRemote:(id,stream)=>{if(mounted.current)setRemote(old=>({...old,[id]:stream}));},onRemoteRemoved:id=>{const element=audio.current.get(id);if(element){element.pause();element.srcObject=null;audio.current.delete(id);}if(mounted.current)setRemote(old=>{const next={...old};delete next[id];return next;});}});
  client.current=current;const leave=()=>current.stop();window.addEventListener("pagehide",leave);
  return ()=>{mounted.current=false;window.removeEventListener("pagehide",leave);current.stop();if(client.current===current)client.current=null;for(const el of audio.current.values()){el.pause();el.srcObject=null;}audio.current.clear();};
 },[groupId,sessionKey]);
 const live=view.phase==="live",joining=view.phase==="joining";
 async function playAudio(){let failed=false;for(const element of audio.current.values())try{await element.play();}catch{failed=true;}if(mounted.current)setBlocked(failed);}
 return <section className="voice-party" aria-label="Group voice" style={{padding:"16px",border:"1px solid var(--line, #34413f)",borderRadius:16,marginTop:16}}>
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
   <div><h3 style={{margin:0}}>Voice</h3><p role="status" aria-live="polite" style={{margin:"6px 0"}}>{live?(view.muted?"Microphone muted":"● Microphone live"):view.message}</p></div>
   <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
    {!live&&!joining&&<button type="button" onClick={()=>void client.current?.join()}>Join voice</button>}
    {joining&&<button type="button" onClick={()=>client.current?.stop()}>Cancel</button>}
    {live&&<><button type="button" aria-pressed={view.muted} onClick={()=>client.current?.mute(!view.muted)}>{view.muted?"Unmute":"Mute"}</button><button type="button" onClick={()=>client.current?.stop()}>Leave voice</button></>}
    {blocked&&live&&<button type="button" onClick={()=>void playAudio()}>Play group audio</button>}
   </div>
  </div>
  {live&&<><p style={{fontSize:13,margin:"8px 0"}}>{view.message}</p><ul style={{margin:"8px 0",paddingLeft:20}}>{view.peers.length?view.peers.map(p=><li key={p.id}>{p.username} · {p.state==="new"?"connecting":p.state}</li>):<li>Waiting for another person to join.</li>}</ul></>}
  <p style={{fontSize:12,opacity:.8,lineHeight:1.5,margin:"10px 0 0"}}>Up to four people. Joining turns on your microphone. Voice goes directly between group members using encrypted WebRTC transport. Members and the connection service may see your IP address. Some networks cannot connect in this beta.</p>
  <details style={{fontSize:12,marginTop:8}}><summary>How voice connects</summary><p>Raw uses Cloudflare’s public STUN service to find a direct connection. Audio is not recorded by Raw. This beta has no relay fallback and has not been independently security audited.</p></details>
  {Object.entries(remote).map(([id,stream])=><PartyAudio key={id} id={id} stream={stream} session={groupId+":"+sessionKey} register={register} onBlocked={playbackBlocked}/>)}
 </section>;
}
