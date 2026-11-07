CREATE TABLE `raw_coins` (
	`event` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`delta` integer NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raw_coins_owner` ON `raw_coins` (`owner`);--> statement-breakpoint
CREATE TABLE `raw_group_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`owner` text NOT NULL,
	`body` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `raw_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raw_group_message_order` ON `raw_group_messages` (`group_id`,`id`);--> statement-breakpoint
CREATE TABLE `raw_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`invite_digest` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_groups_invite_digest_unique` ON `raw_groups` (`invite_digest`);--> statement-breakpoint
CREATE TABLE `raw_likes` (
	`post` text NOT NULL,
	`actor` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`post`, `actor`),
	FOREIGN KEY (`post`) REFERENCES `raw_posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `raw_members` (
	`group_id` text NOT NULL,
	`owner` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`group_id`, `owner`),
	FOREIGN KEY (`group_id`) REFERENCES `raw_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `raw_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`template` text,
	`created` integer NOT NULL,
	`hidden` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raw_posts_feed` ON `raw_posts` (`hidden`,`created`);--> statement-breakpoint
CREATE TABLE `raw_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter` text NOT NULL,
	`post` text NOT NULL,
	`reason` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`reporter`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post`) REFERENCES `raw_posts`(`id`) ON UPDATE no action ON DELETE no action
);
