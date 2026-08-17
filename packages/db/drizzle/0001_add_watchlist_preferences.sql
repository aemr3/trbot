CREATE TABLE `watchlist_preferences` (
	`id` integer PRIMARY KEY NOT NULL,
	`instrument_sort` text NOT NULL,
	`sort_direction` text NOT NULL,
	`candle_range` text NOT NULL,
	`candle_interval` text NOT NULL,
	`updated_at` integer NOT NULL
);
