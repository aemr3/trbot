CREATE TABLE `chat_goals` (
	`session_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`objective` text NOT NULL,
	`status` text NOT NULL,
	`execution_policy` text NOT NULL,
	`turn_count` integer NOT NULL,
	`max_turns` integer NOT NULL,
	`token_budget` integer,
	`started_tokens` integer NOT NULL,
	`used_tokens` integer NOT NULL,
	`last_evaluation` text,
	`pending_event_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_goals_id_unique` ON `chat_goals` (`id`);--> statement-breakpoint
CREATE TABLE `chat_loops` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`interval_ms` integer NOT NULL,
	`status` text NOT NULL,
	`execution_policy` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`run_count` integer NOT NULL,
	`max_runs` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_loops_due` ON `chat_loops` (`status`,`next_run_at`);
