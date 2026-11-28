import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ExternalMediaProvider, RemoteMedia } from './media-provider'
import {
  call,
  checkProject,
  checkTarget,
  mutationSchema,
  listNodes,
  findNodeById,
  readNodes,
  jimengCreateNodeId,
  resourceId,
  type DraftNode,
} from './jimeng-canvas-client'
const downloadReceipt = z.object({
  resourceId,
  path: z.string(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

function operationUuid(operationId: string, purpose: string) {
  const bytes = createHash('sha256')
    .update(purpose + '/' + operationId)
    .digest()
  bytes[6] = (bytes[6]! & 15) | 0x40
  bytes[8] = (bytes[8]! & 63) | 0x80
  const hex = bytes.toString('hex', 0, 16)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function mediaChoices(nodes: DraftNode[]) {
  const result: RemoteMedia[] = []
  for (const node of nodes) {
    // The CLI exposes the candidate set without identifying the selected index.
    // Keep concrete resource identities so the user can choose a specific version.
    for (const resource of node.resources ?? []) {
      const kind = resource.type.toLowerCase()
      if (
        (kind !== 'image' && kind !== 'video' && kind !== 'audio') ||
        resource.status.toLowerCase() !== 'success'
      )
        continue
      result.push({
        nodeId: node.nodeId,
        assetId: resourceId.parse(resource.resourceId),
        kind,
        title: resource.name || node.title || '',
      })
    }
  }
  return result
}

export const jimengCanvasMedia: ExternalMediaProvider = {
  async publish(target, source, operationId, completed) {
    checkTarget(target)
    const expected = { nodeId: jimengCreateNodeId(operationId), assetId: operationId }
    const verify = (node: DraftNode) => {
      checkProject(node.projectId, target)
      if (
        node.nodeId !== expected.nodeId ||
        node.type !== source.kind ||
        !node.resources?.some(
          (r) =>
            r.resourceId === expected.assetId &&
            r.type.toLowerCase() === source.kind &&
            r.status.toLowerCase() === 'success',
        )
      ) {
        throw new Error('已记录的即梦节点与原素材不符，请核对远端节点。')
      }
      return expected
    }
    // All retries and remote acknowledgements share this saved operation identity.
    // A previously verified node which has since been deleted stays deleted.
    const existing = await findNodeById(target, expected.nodeId)
    if (existing) return verify(existing)
    if (completed) throw new Error('此前导出的即梦节点已移除，请核对目标画布。')
    const uploaded = z
      .object({ resourceId, mediaType: z.string(), sourceProjectId: z.string().optional() })
      .parse(
        await call([
          'resource',
          'upload',
          '--project-id',
          target,
          '--resource-id',
          expected.assetId,
          '--file',
          source.path,
          '--type',
          source.kind,
          '--name',
          source.title,
          '--import-kind',
          'local_upload',
        ]),
      )
    checkProject(uploaded.sourceProjectId, target)
    if (
      uploaded.resourceId !== expected.assetId ||
      uploaded.mediaType.toLowerCase() !== source.kind
    )
      throw new Error('上传回执与发出的资源身份不一致，请核对远端素材。')
    const result = mutationSchema.parse(
      await call([
        'node',
        'create',
        source.kind,
        '--project-id',
        target,
        '--node-id',
        expected.nodeId,
        '--resource-id',
        expected.assetId,
        '--submit-id',
        operationUuid(operationId, 'import'),
        '--update-id',
        operationUuid(operationId, 'save'),
        '--import-kind',
        'local_upload',
        '--title',
        source.title,
      ]),
    )
    return verify(result.node)
  },
  async listMedia(target) {
    return mediaChoices(await listNodes(target))
  },
  async readMedia(target, id) {
    checkTarget(target)
    return mediaChoices(await readNodes(target, [id]))
  },
  async download(target, media, destination) {
    checkTarget(target)
    const id = resourceId.parse(media.assetId)
    const receipt = downloadReceipt.parse(
      await call(['resource', 'download', id, '--project-id', target, '--output', destination]),
    )
    if (receipt.resourceId !== id || receipt.path !== destination)
      throw new Error('即梦素材下载回执与选定资源不一致。')
    return { size: receipt.size, sha256: receipt.sha256 }
  },
}
