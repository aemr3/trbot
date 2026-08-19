CREATE TABLE `ai_credentials` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`credential` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`overview_provider` text,
	`overview_model` text,
	`overview_reasoning` text,
	`chat_provider` text,
	`chat_model` text,
	`chat_reasoning` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `reasoning` text;