CREATE TABLE `chat_compactions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`compacted_through_seq` integer NOT NULL,
	`first_kept_seq` integer,
	`tokens_before` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
