import {env} from 'cloudflare:workers';
import {uploadRelease} from '../../../lib/raw-releases';
export const dynamic='force-dynamic';
export function POST(request:Request){return uploadRelease(request,env);}
export const PUT=POST;
