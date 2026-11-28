import type { ExternalContent, ExternalReference, ExternalSpace } from '@plein/protocol'

export type SyncFields = ExternalContent

export interface RemoteItem {
  id: string
  kind: string
  fields: SyncFields
  referenceRevision?: string
  references?: ExternalReference[]
  operationId?: string
  editable: boolean
}

/** A save here must never start generation. Target is a canonical project ID. */
export interface CanvasProvider {
  resolveTarget?(target: string): Promise<string>
  validateCreate?(fields: SyncFields, kind: string): void | Promise<void>
  canCreateAtPosition?(): Promise<boolean>
  createKinds?: readonly string[]
  createdId?(operationId: string): string
  spaces?(): Promise<ExternalSpace[]>
  projects?(space?: string): Promise<{ id: string; title: string }[]>
  read?(target: string, id: string): Promise<RemoteItem>
  list(target: string): Promise<RemoteItem[]>
  update(target: string, item: RemoteItem, fields: SyncFields): Promise<void>
  create?(target: string, fields: SyncFields, operationId: string, kind?: string): Promise<string>
}
