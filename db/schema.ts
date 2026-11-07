import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("raw_users", {
  id: text("id").primaryKey(), username: text("username").notNull().unique(),
  salt: text("salt").notNull(), verifier: text("verifier").notNull(),
  clientSalt: text("client_salt").notNull(), created: integer("created").notNull(),
});
export const sessions = sqliteTable("raw_sessions", {
  digest: text("digest").primaryKey(), owner: text("owner").notNull().references(() => users.id),
  expires: integer("expires").notNull(), created: integer("created").notNull(),
}, t => [index("raw_sessions_owner").on(t.owner)]);
export const rates = sqliteTable("raw_rates", {
  id: text("id").primaryKey(), attempts: integer("attempts").notNull(), until: integer("until").notNull(),
});
export const versions = sqliteTable("raw_versions", {
  owner: text("owner").notNull().references(() => users.id), space: text("space").notNull(),
  revision: integer("revision").notNull(), payload: text("payload").notNull(), digest: text("digest").notNull(),
  bytes: integer("bytes").notNull(), created: integer("created").notNull(),
}, t => [primaryKey({columns:[t.owner,t.space,t.revision]})]);

export const posts = sqliteTable("raw_posts", {
  id:text("id").primaryKey(), owner:text("owner").notNull().references(()=>users.id),
  kind:text("kind").notNull(), title:text("title").notNull(), body:text("body").notNull(),
  template:text("template"), created:integer("created").notNull(), hidden:integer("hidden").notNull().default(0),
},t=>[index("raw_posts_feed").on(t.hidden,t.created)]);
export const likes = sqliteTable("raw_likes", {
  post:text("post").notNull().references(()=>posts.id), actor:text("actor").notNull().references(()=>users.id), created:integer("created").notNull(),
},t=>[primaryKey({columns:[t.post,t.actor]})]);
export const coins = sqliteTable("raw_coins", {
  event:text("event").primaryKey(), owner:text("owner").notNull().references(()=>users.id),
  delta:integer("delta").notNull(), created:integer("created").notNull(),
},t=>[index("raw_coins_owner").on(t.owner)]);
export const groups = sqliteTable("raw_groups", {
  id:text("id").primaryKey(), owner:text("owner").notNull().references(()=>users.id),name:text("name").notNull(),
  inviteDigest:text("invite_digest").notNull().unique(),created:integer("created").notNull(),
});
export const members = sqliteTable("raw_members", {
  group:text("group_id").notNull().references(()=>groups.id),owner:text("owner").notNull().references(()=>users.id),created:integer("created").notNull(),
},t=>[primaryKey({columns:[t.group,t.owner]})]);
export const groupMessages = sqliteTable("raw_group_messages", {
  id:integer("id").primaryKey({autoIncrement:true}),group:text("group_id").notNull().references(()=>groups.id),
  owner:text("owner").notNull().references(()=>users.id),body:text("body").notNull(),created:integer("created").notNull(),
},t=>[index("raw_group_message_order").on(t.group,t.id)]);
export const reports = sqliteTable("raw_reports", {
  id:text("id").primaryKey(),reporter:text("reporter").notNull().references(()=>users.id),post:text("post").notNull().references(()=>posts.id),
  reason:text("reason").notNull(),created:integer("created").notNull(),
});
export const announcements = sqliteTable("raw_announcements", {
  id:text("id").primaryKey(),title:text("title").notNull(),body:text("body").notNull(),
  version:text("version").notNull(),created:integer("created").notNull(),
});
export const operatorAudit = sqliteTable("raw_operator_audit", {
  id:text("id").primaryKey(),action:text("action").notNull(),target:text("target").notNull(),created:integer("created").notNull(),
});
export const voicePeers = sqliteTable("raw_voice_peers", {
  group:text("group_id").notNull().references(()=>groups.id),owner:text("owner").notNull().references(()=>users.id),
  expires:integer("expires").notNull(),
},t=>[primaryKey({columns:[t.group,t.owner]})]);
export const voiceSignals = sqliteTable("raw_voice_signals", {
  id:integer("id").primaryKey({autoIncrement:true}),group:text("group_id").notNull().references(()=>groups.id),
  sender:text("sender").notNull().references(()=>users.id),recipient:text("recipient").notNull().references(()=>users.id),
  kind:text("kind").notNull(),data:text("data").notNull(),created:integer("created").notNull(),expires:integer("expires").notNull(),
},t=>[index("raw_voice_delivery").on(t.group,t.recipient,t.id)]);
export const challenges = sqliteTable("raw_challenges", {
  id:text("id").primaryKey(),creator:text("creator").notNull().references(()=>users.id),target:text("target").notNull().references(()=>users.id),
  title:text("title").notNull(),stake:integer("stake").notNull(),state:text("state").notNull(),
  proposal:text("proposal"),proposer:text("proposer"),winner:text("winner"),created:integer("created").notNull(),expires:integer("expires").notNull(),
},t=>[index("raw_challenge_people").on(t.creator,t.target)]);
