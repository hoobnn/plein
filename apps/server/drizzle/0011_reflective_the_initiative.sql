CREATE TABLE `external_canvas_links` (
	`canvasId` text NOT NULL,
	`provider` text NOT NULL,
	`target` text NOT NULL,
	`localId` text NOT NULL,
	`remoteId` text,
	`baseline` text NOT NULL,
	`operationId` text NOT NULL,
	PRIMARY KEY(`canvasId`, `provider`, `target`, `localId`),
	FOREIGN KEY (`canvasId`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_canvas_remote` ON `external_canvas_links` (`canvasId`,`provider`,`target`,`remoteId`);