CREATE TABLE `raw_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`version` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`creator` text NOT NULL,
	`target` text NOT NULL,
	`title` text NOT NULL,
	`stake` integer NOT NULL,
	`state` text NOT NULL,
	`proposal` text,
	`proposer` text,
	`winner` text,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`creator`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raw_challenge_people` ON `raw_challenges` (`creator`,`target`);--> statement-breakpoint
CREATE TABLE `raw_operator_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_voice_peers` (
	`group_id` text NOT NULL,
	`owner` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`group_id`, `owner`),
	FOREIGN KEY (`group_id`) REFERENCES `raw_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `raw_voice_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `raw_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raw_voice_delivery` ON `raw_voice_signals` (`group_id`,`recipient`,`id`);