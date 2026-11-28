import { z } from 'zod'

export const ExternalPlatform = z.enum(['jimeng-canvas', 'jimeng-novel'])
export type ExternalPlatform = z.infer<typeof ExternalPlatform>
export const ExternalTarget = z.object({
  provider: ExternalPlatform,
  target: z.string().trim().min(1).max(2048),
})
export type ExternalTarget = z.infer<typeof ExternalTarget>
export const ExternalAction = z.enum(['pull', 'push', 'merge', 'unlink', 'reconcile'])
export type ExternalAction = z.infer<typeof ExternalAction>
export const ExternalApply = ExternalTarget.extend({
  action: ExternalAction,
  rowId: z.string().min(1).max(4096),
  revision: z.string().length(64),
  /** For a pending create, the remote item explicitly selected by the user. */
  remoteId: z.string().min(1).max(2048).optional(),
})
export type ExternalApply = z.infer<typeof ExternalApply>
export interface ExternalContent {
  title: string
  text: string
  position?: { x: number; y: number }
}
export type ExternalState =
  | 'remote-only'
  | 'local-only'
  | 'synced'
  | 'local-changed'
  | 'remote-changed'
  | 'mergeable'
  | 'conflict'
  | 'missing-local'
  | 'missing-remote'
  | 'pending'
export interface ExternalReference {
  label: string
  usage: string
  sourceId?: string
}
export interface ExternalRow {
  references?: ExternalReference[]
  rowId: string
  revision: string
  kind: string
  state: ExternalState
  localId: string | null
  remoteId: string | null
  local: ExternalContent | null
  remote: ExternalContent | null
  merged?: ExternalContent
  actions: ExternalAction[]
}
export interface ExternalPreview extends ExternalTarget {
  /** Verified remote space/project when a legacy binding still uses an unqualified ID. */
  resolvedTarget?: string
  rows: ExternalRow[]
}
export const EXTERNAL_IMPORT_LIMIT = 200
export const ExternalPullNew = ExternalTarget.extend({
  rows: z
    .array(z.object({ rowId: ExternalApply.shape.rowId, revision: ExternalApply.shape.revision }))
    .min(1)
    .max(EXTERNAL_IMPORT_LIMIT),
})
export type ExternalPullNew = z.infer<typeof ExternalPullNew>

export const ExternalSpaceId = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/)
export interface ExternalSpace {
  id: string
  title: string
  current: boolean
}
export const ExternalSpacesRequest = z.object({ provider: ExternalPlatform }).strict()
export const ExternalProjectsRequest = ExternalSpacesRequest.extend({
  space: ExternalSpaceId.optional(),
})
