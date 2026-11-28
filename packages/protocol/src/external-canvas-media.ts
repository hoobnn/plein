import { z } from 'zod'
import { ExternalTarget } from './external-canvas'

export const RemoteMedia = z.object({
  nodeId: z.string().min(1).max(2048),
  assetId: z.string().min(1).max(2048),
  kind: z.enum(['image', 'video', 'audio']),
  title: z.string(),
  replaceable: z.boolean().optional(),
})
export type RemoteMedia = z.infer<typeof RemoteMedia>
export const ExternalMediaImport = ExternalTarget.extend({
  nodeId: RemoteMedia.shape.nodeId,
  assetId: RemoteMedia.shape.assetId,
})
export const ExternalMediaReplace = ExternalMediaImport.extend({
  localAssetId: z.string().regex(/^[a-f0-9]{64}$/),
})
export const ExternalMediaPublish = ExternalTarget.extend({
  localAssetId: ExternalMediaReplace.shape.localAssetId,
})
export const externalMediaPath = (
  canvasId: string,
  action: 'list' | 'import' | 'replace' | 'publish',
) => `/api/canvases/${encodeURIComponent(canvasId)}/external/media/${action}`
