CREATE TABLE `external_media_exports` (
	`canvasId` text NOT NULL,
	`provider` text NOT NULL,
	`target` text NOT NULL,
	`localAssetId` text NOT NULL,
	`operationId` text NOT NULL,
	`remoteNodeId` text,
	`remoteAssetId` text,
	PRIMARY KEY(`canvasId`, `provider`, `target`, `localAssetId`),
	FOREIGN KEY (`canvasId`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
