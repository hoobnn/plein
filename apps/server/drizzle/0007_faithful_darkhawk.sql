CREATE TABLE `voices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`voice_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voices_owner_voice` ON `voices` (`owner_id`,`provider`,`voice_id`);