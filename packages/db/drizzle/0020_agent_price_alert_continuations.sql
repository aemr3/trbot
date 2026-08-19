ALTER TABLE `chat_messages` ADD `model_content` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `event_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_event_key_unique` ON `chat_messages` (`event_key`);--> statement-breakpoint
ALTER TABLE `price_alerts` ADD `chat_session_id` text;--> statement-breakpoint
ALTER TABLE `price_alerts` ADD `on_trigger` text;--> statement-breakpoint
ALTER TABLE `price_alerts` ADD `trigger_id` text;