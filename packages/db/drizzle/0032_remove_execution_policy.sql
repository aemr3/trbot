ALTER TABLE `chat_goals` DROP COLUMN `execution_policy`;--> statement-breakpoint
ALTER TABLE `chat_loops` DROP COLUMN `execution_policy`;--> statement-breakpoint
UPDATE `chat_permission_requests` SET `scope` = 'SESSION' WHERE `scope` = 'CHAT';
