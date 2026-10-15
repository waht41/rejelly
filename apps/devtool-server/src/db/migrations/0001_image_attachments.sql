CREATE TABLE `trace_attachments` (
	`hash` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL
);
