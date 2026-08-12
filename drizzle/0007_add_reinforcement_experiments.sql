CREATE TABLE `reinforcement_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_version` text NOT NULL,
	`cutoff_date` text NOT NULL,
	`policy_id` text NOT NULL,
	`artifact_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `reinforcement_policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reinforcement_experiments_created_idx` ON `reinforcement_experiments` (`created_at`);--> statement-breakpoint
CREATE INDEX `reinforcement_experiments_feature_cutoff_idx` ON `reinforcement_experiments` (`feature_version`,`cutoff_date`);