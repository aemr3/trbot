CREATE TABLE `chat_subagent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`parent_tool_call_id` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`reasoning` text,
	`automation_label` text,
	`automation_reference_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`notified_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_subagent_jobs_session_status` ON `chat_subagent_jobs` (`session_id`,`status`);--> statement-breakpoint
CREATE TABLE `chat_subagent_tasks` (
	`job_id` text NOT NULL,
	`task_index` integer NOT NULL,
	`agent` text NOT NULL,
	`task_template` text NOT NULL,
	`resolved_task` text,
	`session_ids` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`cost_total` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`job_id`, `task_index`),
	FOREIGN KEY (`job_id`) REFERENCES `chat_subagent_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_subagent_tasks_job_status` ON `chat_subagent_tasks` (`job_id`,`status`);
