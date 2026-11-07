import {env} from 'cloudflare:workers';
import {readRelease} from '../../lib/raw-releases';
export const dynamic='force-dynamic';
export function GET(){return readRelease('announcements',env);}
