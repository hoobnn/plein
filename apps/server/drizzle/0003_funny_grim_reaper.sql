CREATE TABLE `batch_items` (
	`group_id` text NOT NULL,
	`node_id` text NOT NULL,
	`seq` integer NOT NULL,
	`stage` text NOT NULL,
	`reason` text,
	`input_hash` text,
	`plan_hash` text,
	`deps` text DEFAULT '[]' NOT NULL,
	`input` text,
	`frozen_hash` text,
	`job_id` text,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`result_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `node_id`),
	FOREIGN KEY (`group_id`) REFERENCES `job_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `expect` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `frozen` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `recovery` text;