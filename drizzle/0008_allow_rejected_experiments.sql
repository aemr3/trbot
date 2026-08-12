PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reinforcement_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_version` text NOT NULL,
	`cutoff_date` text NOT NULL,
	`policy_id` text,
	`artifact_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `reinforcement_policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_reinforcement_experiments`("id", "feature_version", "cutoff_date", "policy_id", "artifact_json", "created_at", "updated_at") SELECT "id", "feature_version", "cutoff_date", "policy_id", "artifact_json", "created_at", "updated_at" FROM `reinforcement_experiments`;--> statement-breakpoint
DROP TABLE `reinforcement_experiments`;--> statement-breakpoint
ALTER TABLE `__new_reinforcement_experiments` RENAME TO `reinforcement_experiments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `reinforcement_experiments_created_idx` ON `reinforcement_experiments` (`created_at`);--> statement-breakpoint
CREATE INDEX `reinforcement_experiments_feature_cutoff_idx` ON `reinforcement_experiments` (`feature_version`,`cutoff_date`);