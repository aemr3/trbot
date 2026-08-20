PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_loops` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`uses_default_prompt` integer NOT NULL,
	`schedule` text NOT NULL,
	`interval_ms` integer,
	`cron_expression` text,
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
INSERT INTO `__new_chat_loops`("id", "session_id", "prompt", "uses_default_prompt", "schedule", "interval_ms", "cron_expression", "status", "execution_policy", "next_run_at", "last_run_at", "run_count", "max_runs", "expires_at", "created_at", "updated_at") SELECT "id", "session_id", "prompt", 0, 'INTERVAL', "interval_ms", NULL, "status", "execution_policy", "next_run_at", "last_run_at", "run_count", "max_runs", "expires_at", "created_at", "updated_at" FROM `chat_loops`;--> statement-breakpoint
DROP TABLE `chat_loops`;--> statement-breakpoint
ALTER TABLE `__new_chat_loops` RENAME TO `chat_loops`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chat_loops_due` ON `chat_loops` (`status`,`next_run_at`);
