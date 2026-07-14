CREATE TABLE `trace_attrs` (
	`trace_id` text NOT NULL,
	`key` text NOT NULL,
	`value_type` text NOT NULL,
	`value_text` text,
	`value_num` real,
	PRIMARY KEY(`trace_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_trace_attrs_key_text` ON `trace_attrs` (`key`,`value_text`);--> statement-breakpoint
CREATE INDEX `idx_trace_attrs_key_num` ON `trace_attrs` (`key`,`value_num`);--> statement-breakpoint
CREATE TABLE `trace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`span_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`parent_id` text,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`agent_id` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_trace_id_ts` ON `trace_events` (`trace_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_trace_id_ts_seq` ON `trace_events` (`trace_id`,`timestamp`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_ts` ON `trace_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_span_id` ON `trace_events` (`span_id`);--> statement-breakpoint
CREATE INDEX `idx_type` ON `trace_events` (`type`);--> statement-breakpoint
CREATE INDEX `idx_agent_id` ON `trace_events` (`agent_id`);--> statement-breakpoint
CREATE TABLE `trace_summaries` (
	`trace_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_source` text DEFAULT 'trace' NOT NULL,
	`entry_type` text,
	`entry_span_id` text,
	`input_preview` text,
	`output_preview` text,
	`output_full` text,
	`status` text NOT NULL,
	`end_reason` text,
	`error_message` text,
	`error_full` text,
	`timestamp` integer NOT NULL,
	`duration` integer,
	`total_tokens` integer DEFAULT 0,
	`costs` text,
	`generation_count` integer DEFAULT 0,
	`llm_call_count` integer DEFAULT 0,
	`tool_call_count` integer DEFAULT 0,
	`tool_executions` text,
	`tool_usage` text,
	`llm_usage` text,
	`is_starred` integer DEFAULT false,
	`tags` text
);
--> statement-breakpoint
CREATE INDEX `idx_ts_time` ON `trace_summaries` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_ts_name` ON `trace_summaries` (`name`);--> statement-breakpoint
CREATE INDEX `idx_ts_status` ON `trace_summaries` (`status`);--> statement-breakpoint
CREATE INDEX `idx_ts_entry_type` ON `trace_summaries` (`entry_type`);--> statement-breakpoint
CREATE INDEX `idx_ts_starred` ON `trace_summaries` (`is_starred`);