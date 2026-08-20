CREATE TABLE `market_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_uid` text NOT NULL,
	`symbol` text NOT NULL,
	`display_name` text NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`value` real NOT NULL,
	`basis` text NOT NULL,
	`interval` text,
	`repeat` text NOT NULL,
	`status` text NOT NULL,
	`trigger_price` real,
	`extreme_price` real,
	`reference_price` real,
	`atr_value` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`triggered_at` integer,
	`triggered_price` real,
	`chat_session_id` text NOT NULL,
	`on_trigger` text NOT NULL,
	`trigger_id` text
);--> statement-breakpoint
INSERT INTO `market_monitors` (
	`id`, `instrument_uid`, `symbol`, `display_name`, `direction`, `kind`, `value`, `basis`, `interval`, `repeat`,
	`status`, `trigger_price`, `extreme_price`, `reference_price`, `atr_value`, `created_at`, `updated_at`,
	`triggered_at`, `triggered_price`, `chat_session_id`, `on_trigger`, `trigger_id`
)
SELECT
	`id`, `instrument_uid`, `symbol`, `display_name`, `direction`, `kind`, `value`, `basis`, `interval`, `repeat`,
	`status`, `trigger_price`, `extreme_price`, `reference_price`, `atr_value`, `created_at`, `updated_at`,
	`triggered_at`, `triggered_price`, `chat_session_id`,
	COALESCE(NULLIF(TRIM(`on_trigger`), ''), 'Refresh current market and account data, reassess this trigger, and report the result to the user.'),
	`trigger_id`
FROM `price_alerts`
WHERE `chat_session_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `price_alerts` WHERE `chat_session_id` IS NOT NULL;
