CREATE TABLE `chat_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`urgency` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_notifications_created_at` ON `chat_notifications` (`created_at`);
