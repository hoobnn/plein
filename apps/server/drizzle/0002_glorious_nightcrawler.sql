CREATE TABLE `impact_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`canvas_id` text NOT NULL,
	`node_id` text NOT NULL,
	`result_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`causes` text DEFAULT '[]' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `impact_decisions_canvas` ON `impact_decisions` (`canvas_id`,`created_at`);