CREATE TABLE `overview_snapshots` (
	`instrument_uid` text NOT NULL,
	`mode` text NOT NULL,
	`digest` text NOT NULL,
	`commentary` text NOT NULL,
	`generated_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instrument_uid`, `mode`)
);
