PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_goals` (
	`session_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`objective` text NOT NULL,
	`status` text NOT NULL,
	`turn_count` integer NOT NULL,
	`max_turns` integer,
	`token_budget` integer,
	`started_tokens` integer NOT NULL,
	`used_tokens` integer NOT NULL,
	`last_evaluation` text,
	`pending_event_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_chat_goals`("session_id", "id", "objective", "status", "turn_count", "max_turns", "token_budget", "started_tokens", "used_tokens", "last_evaluation", "pending_event_key", "created_at", "updated_at") SELECT "session_id", "id", "objective", "status", "turn_count", NULL, "token_budget", "started_tokens", "used_tokens", "last_evaluation", "pending_event_key", "created_at", "updated_at" FROM `chat_goals`;--> statement-breakpoint
DROP TABLE `chat_goals`;--> statement-breakpoint
ALTER TABLE `__new_chat_goals` RENAME TO `chat_goals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_goals_id_unique` ON `chat_goals` (`id`);--> statement-breakpoint
UPDATE `chat_messages`
SET `effects` = (
	SELECT json_group_array(json(
		CASE WHEN json_extract(value, '$.kind') = 'CHAT_GOAL'
			THEN json_set(value, '$.before.maxTurns', NULL, '$.after.maxTurns', NULL)
			ELSE value
		END
	))
	FROM json_each(`chat_messages`.`effects`)
)
WHERE `effects` IS NOT NULL
	AND json_valid(`effects`)
	AND EXISTS (
		SELECT 1 FROM json_each(`chat_messages`.`effects`)
		WHERE json_extract(value, '$.kind') = 'CHAT_GOAL'
	);
