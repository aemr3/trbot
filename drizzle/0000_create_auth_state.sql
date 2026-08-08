CREATE TABLE `auth_state` (
	`account_key` text PRIMARY KEY NOT NULL,
	`member_uid` text,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`device_id` text NOT NULL,
	`user_agent_uid` text NOT NULL,
	`private_key_pem` text NOT NULL,
	`public_key_base64` text NOT NULL,
	`login_reference_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
