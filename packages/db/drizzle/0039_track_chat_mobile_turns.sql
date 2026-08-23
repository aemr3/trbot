CREATE TABLE `chat_mobile_turns` (
	`prompt_message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`external_message_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`prompt_message_id`, `channel`, `external_chat_id`),
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_mobile_turns_session` ON `chat_mobile_turns` (`session_id`);