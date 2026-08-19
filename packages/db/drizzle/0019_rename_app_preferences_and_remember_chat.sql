ALTER TABLE `watchlist_preferences` RENAME TO `app_preferences`;--> statement-breakpoint
ALTER TABLE `app_preferences` ADD `selected_chat_session_id` text;
