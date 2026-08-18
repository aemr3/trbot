CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`route` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_body` text NOT NULL,
	`created_at` integer NOT NULL
);
