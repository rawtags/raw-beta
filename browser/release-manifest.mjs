// Public verification only. This browser module never imports a server binding,
// operator secret or signing key. The pin matches Raw's installed updater.
export const RELEASE_PUBLIC_KEY='MCowBQYDK2VwAyEAA6j8yWChLQns5wF6faqkHNHc0a7E5efjDAo1r4QLfr0=';
export const RELEASE_ORIGIN='https://raw-private-beta.rawtags.chatgpt.site';
export const MAX_MANIFEST_BYTES=66000;
const enc=new TextEncoder();
export class ReleaseUnavailable extends Error {constructor(status){super('Windows release details are unavailable.');this.status=status;}}
function base64(value,bytes){if(typeof value!=='string'||value.length!==4*Math.ceil(bytes/3)||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('Publisher signature could not be verified.');let text;try{text=atob(value);}catch{throw Error('Publisher signature could not be verified.');}if(text.length!==bytes||btoa(text)!==value)throw Error('Publisher signature could not be verified.');return Uint8Array.from(text,c=>c.charCodeAt(0));}
/** Structural checks alone do not establish trust. Use verifyReleaseManifest. */
export function validatePublicRelease(value,now=Date.now()){
 const expiry=typeof value?.expires==='string'?Date.parse(value.expires):NaN;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!==1||value.platform!=='win32-x64'||value.url!==RELEASE_ORIGIN+'/Raw-Setup.exe'||typeof value.version!=='string'||!/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value.version)||!Number.isFinite(now)||!Number.isFinite(expiry)||expiry<=now||expiry>now+32*86400000||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>400*1024*1024||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.notes!=='string'||value.notes.length>12000)throw Error('Windows release details are invalid or expired.');
 return Object.freeze({schema:1,version:value.version,platform:'win32-x64',url:value.url,bytes:value.bytes,sha256:value.sha256,expires:value.expires,notes:value.notes});
}
export async function verifyReleaseManifest(text,now){
 if(typeof text!=='string'||enc.encode(text).length>MAX_MANIFEST_BYTES)throw Error('Windows release details exceed their limit.');
 let envelope;try{envelope=JSON.parse(text);}catch{throw Error('Windows release details are unreadable.');}
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).some(k=>!['payload','signature'].includes(k))||typeof envelope.payload!=='string'||enc.encode(envelope.payload).length>64000)throw Error('Publisher signature could not be verified.');
 const signature=base64(envelope.signature,64),spki=Uint8Array.from(atob(RELEASE_PUBLIC_KEY),c=>c.charCodeAt(0));
 const key=await crypto.subtle.importKey('spki',spki,'Ed25519',false,['verify']);
 // Authenticate the exact bytes before interpreting version, URL or release text.
 if(!await crypto.subtle.verify('Ed25519',key,signature,enc.encode(envelope.payload)))throw Error('Publisher signature could not be verified.');
 let value;try{value=JSON.parse(envelope.payload);}catch{throw Error('Signed Windows release details are unreadable.');}
 return validatePublicRelease(value,now===undefined?Date.now():now);
}
export async function loadReleaseManifest(fetcher=fetch,signal,now){
 const response=await fetcher('/desktop-channel.json',{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal});
 if(!response.ok){await response.body?.cancel();throw new ReleaseUnavailable(response.status);}
 const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_MANIFEST_BYTES)){await response.body?.cancel();throw Error('Windows release details exceed their limit.');}
 if(!response.body)throw Error('Windows release details are unavailable.');const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){if(signal?.aborted)throw Error('Release check cancelled.');const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_MANIFEST_BYTES){await reader.cancel();throw Error('Windows release details exceed their limit.');}chunks.push(part.value);}}finally{reader.releaseLock();}
 if(signal?.aborted)throw Error('Release check cancelled.');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const result=await verifyReleaseManifest(new TextDecoder('utf-8',{fatal:true}).decode(bytes),now);
 if(signal?.aborted)throw Error('Release check cancelled.');return result;
}
