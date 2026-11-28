import type { RemoteMedia } from '@plein/protocol'
export type { RemoteMedia } from '@plein/protocol'

export interface PublishSource {
  kind: RemoteMedia['kind']
  title: string
  path: string
}
export interface PublishedMedia {
  nodeId: string
  assetId: string
}
export interface ExternalMediaProvider {
  resolveTarget?(target: string): Promise<string>
  publish?(
    target: string,
    source: PublishSource,
    operationId: string,
    completed: boolean,
  ): Promise<PublishedMedia>
  listMedia(target: string): Promise<RemoteMedia[]>
  readMedia?(target: string, nodeId: string): Promise<RemoteMedia[]>
  /** Destination is a new file inside the service-owned temporary directory. */
  download(
    target: string,
    media: RemoteMedia,
    destination: string,
  ): Promise<void | { size: number; sha256: string }>
  /** Source has been verified by the service and belongs to the authenticated owner. */
  replace?(target: string, media: RemoteMedia, source: string): Promise<string>
}
