CREATE TABLE `agent_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`model_ref` text,
	`transcript` text DEFAULT '[]' NOT NULL,
	`execution` text DEFAULT '{}' NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_turns_session` ON `agent_turns` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `canvas_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`source_canvas_id` text,
	`source_canvas_title` text NOT NULL,
	`name` text NOT NULL,
	`state` blob NOT NULL,
	`history` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `canvas_checkpoints_project` ON `canvas_checkpoints` (`owner_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `checkpoint_assets` (
	`checkpoint_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`checkpoint_id`, `owner_id`, `asset_id`),
	FOREIGN KEY (`checkpoint_id`) REFERENCES `canvas_checkpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`,`asset_id`) REFERENCES `assets`(`owner_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `media_index_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `media_sources` (
	`owner_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`locator` text NOT NULL,
	`project_id` text,
	`canvas_id` text,
	`node_id` text,
	`result_id` text,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`adopted` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_id`, `asset_id`, `source_type`, `source_id`, `locator`)
);
--> statement-breakpoint
CREATE INDEX `media_sources_project` ON `media_sources` (`owner_id`,`project_id`,`asset_id`);--> statement-breakpoint
CREATE INDEX `media_sources_source` ON `media_sources` (`owner_id`,`source_type`,`source_id`);