CREATE TABLE `chat_message_blocks` (
	`message_id` text NOT NULL,
	`idx` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`signature` text,
	`redacted` integer,
	`tool_call_id` text,
	`tool_name` text,
	`tool_arguments` text,
	`mime_type` text,
	`data` text,
	`extra` text,
	PRIMARY KEY(`message_id`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`text` text NOT NULL,
	`api` text,
	`provider` text,
	`model` text,
	`response_model` text,
	`response_id` text,
	`stop_reason` text,
	`error_message` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`total_tokens` integer,
	`cost_input` real,
	`cost_output` real,
	`cost_cache_read` real,
	`cost_cache_write` real,
	`cost_total` real,
	`tool_call_id` text,
	`tool_name` text,
	`is_error` integer,
	`details` text,
	`harness_version` text,
	`extra` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_messages_session_seq` ON `chat_messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `provider_state` DROP COLUMN `email`;