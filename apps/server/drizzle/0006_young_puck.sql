ALTER TABLE `agent_sessions` ADD `settings` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `context` text DEFAULT '{"source":"unavailable","messages":0}' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `context_cutoff` integer;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `context_reset_at` integer;