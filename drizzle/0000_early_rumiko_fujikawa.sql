CREATE TABLE `raw_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_sessions` (
	`digest` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires` integer NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raw_sessions_owner` ON `raw_sessions` (`owner`);--> statement-breakpoint
CREATE TABLE `raw_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`salt` text NOT NULL,
	`verifier` text NOT NULL,
	`client_salt` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_users_username_unique` ON `raw_users` (`username`);--> statement-breakpoint
CREATE TABLE `raw_versions` (
	`owner` text NOT NULL,
	`space` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`bytes` integer NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`owner`, `space`, `revision`),
	FOREIGN KEY (`owner`) REFERENCES `raw_users`(`id`) ON UPDATE no action ON DELETE no action
);
