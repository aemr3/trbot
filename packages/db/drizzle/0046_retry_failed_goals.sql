ALTER TABLE `chat_goals` ADD `failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_goals` ADD `retry_at` integer;