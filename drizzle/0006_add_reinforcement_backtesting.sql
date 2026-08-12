CREATE TABLE `market_candles` (
	`instrument_uid` text NOT NULL,
	`interval` text NOT NULL,
	`timestamp` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instrument_uid`, `interval`, `timestamp`)
);
--> statement-breakpoint
CREATE INDEX `market_candles_interval_timestamp_idx` ON `market_candles` (`interval`,`timestamp`);--> statement-breakpoint
CREATE TABLE `reinforcement_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`algorithm` text NOT NULL,
	`feature_version` text NOT NULL,
	`feature_names_json` text NOT NULL,
	`configuration_json` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`costs_json` text NOT NULL,
	`partitions_json` text NOT NULL,
	`training_json` text NOT NULL,
	`validation_json` text NOT NULL,
	`test_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reinforcement_policies_created_idx` ON `reinforcement_policies` (`created_at`);--> statement-breakpoint
CREATE INDEX `reinforcement_policies_feature_created_idx` ON `reinforcement_policies` (`feature_version`,`created_at`);