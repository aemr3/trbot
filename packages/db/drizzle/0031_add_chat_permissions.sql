CREATE TABLE `chat_permission_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_permission_requests_created_at` ON `chat_permission_requests` (`created_at`);--> statement-breakpoint
CREATE TABLE `chat_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`questions` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_questions_created_at` ON `chat_questions` (`created_at`);--> statement-breakpoint
CREATE TABLE `chat_tool_permissions` (
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `tool_name`),
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
