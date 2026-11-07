import { env } from "cloudflare:workers";
import { handleRawAccount } from "../../lib/raw-accounts";
export const dynamic = "force-dynamic";
export function GET(request:Request) {return env.DB?handleRawAccount(request,env.DB,Date.now,env.BUCKET,(env as Cloudflare.Env & {RAW_OPERATOR_KEY?:string}).RAW_OPERATOR_KEY):Response.json({error:"Service unavailable."},{status:503});}
export const POST=GET;
