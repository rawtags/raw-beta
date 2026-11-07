import {env} from 'cloudflare:workers';
import {handleServiceBackup} from '../../../lib/raw-backup';
export const dynamic='force-dynamic';
export function POST(request:Request){return handleServiceBackup(request,env.DB,env.BUCKET,(env as Cloudflare.Env&{RAW_BACKUP_KEY?:string}).RAW_BACKUP_KEY);}
export const GET=POST;
