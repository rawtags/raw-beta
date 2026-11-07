declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RAW_OPERATOR_KEY?: string;
    RAW_BACKUP_KEY?: string;
  }
}
