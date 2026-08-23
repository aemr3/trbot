CREATE TABLE `chat_mobile_connections` (
	`session_id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_user_id` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`display_name` text NOT NULL,
	`connected_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_mobile_connections_external_user` ON `chat_mobile_connections` (`channel`,`external_user_id`);
