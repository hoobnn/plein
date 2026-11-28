import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { parseNovelTarget } from './targets'
import type { ExternalMediaProvider, RemoteMedia } from './media-provider'
import {
  command,
  invoke,
  save,
  listCards,
  nodeId,
  projectsInSpace,
  toItem,
  readNovelCard,
  resolveNovelTarget,
  type NovelCard,
} from './jimeng-novel'

const mediaKind = z.enum(['image', 'video', 'audio'])
const currentMedia = z.object({
  nodeId,
  config: z.object({ type: mediaKind }),
  state: z.object({ selectedAssetId: nodeId, status: z.string().nullish() }),
})

// Only caller-owned files resolved by the Plein asset store can reach this server-side API.
async function replaceMedia(target: string, media: RemoteMedia, source: string): Promise<string> {
  if (!isAbsolute(source)) throw new Error('需要服务端素材文件的绝对路径')
  const id = nodeId.parse(media.nodeId)
  const args = ['node', 'get', '--node-id', id]
  const anchor = await invoke(target, args)
  const assertCurrent = (raw: unknown) => {
    const n = currentMedia.parse(raw)
    if (n.state.status === 'running') throw new Error('即梦短剧节点正在生成，请等待结束后重新选择')
    if (
      n.nodeId !== id ||
      n.config.type !== media.kind ||
      n.state.selectedAssetId !== media.assetId
    )
      throw new Error('即梦短剧当前素材已变化，请刷新后核对')
  }
  assertCurrent(anchor.data)
  const team = anchor.confirmedTeam
  if (team === undefined) throw new Error('无法确认项目所属即梦空间，未上传素材')
  const { projectId } = parseNovelTarget(target)
  if (!(await projectsInSpace(team)).some((p) => p.id === projectId))
    throw new Error('目标短剧不在当前确认的空间内，未上传素材')
  const scoped = team + '/' + projectId
  const asset = z
    .object({ assetId: nodeId, type: mediaKind, status: z.literal('ready') })
    .parse(await command(undefined, ['resource', 'upload', '--file', source, '--wait', '30'], team))
  if (asset.type !== media.kind) throw new Error('上传后的素材类型与原节点不同')
  assertCurrent(await command(scoped, args))
  const result = currentMedia.parse(
    await save(scoped, ['node', 'update', '--node-id', id], { assetId: asset.assetId }),
  )
  if (
    result.nodeId !== id ||
    result.config.type !== media.kind ||
    result.state.selectedAssetId !== asset.assetId
  )
    throw new Error('短剧素材绑定回执未确认，请重新读取当前节点')
  return asset.assetId
}

async function selectedMedia(
  target: string,
  cards: NovelCard[],
  team?: string,
): Promise<RemoteMedia[]> {
  const projectId = parseNovelTarget(target).projectId
  const writableSpace =
    !!team &&
    cards.some((n) => n.selectedAssetId && mediaKind.safeParse(n.type).success) &&
    (await projectsInSpace(team).then(
      (projects) => projects.some((p) => p.id === projectId),
      () => false,
    ))
  return cards.flatMap((n) => {
    if (!n.selectedAssetId) return []
    const kind = mediaKind.safeParse(n.type === 'role' || n.type === 'scene' ? 'image' : n.type)
    if (!kind.success) return []
    return [
      {
        nodeId: n.nodeId,
        assetId: nodeId.parse(n.selectedAssetId),
        kind: kind.data,
        title: toItem(n).fields.title,
        replaceable: writableSpace && n.status !== 'running' && mediaKind.safeParse(n.type).success,
      },
    ]
  })
}

export const jimengNovelMedia: ExternalMediaProvider = {
  resolveTarget: resolveNovelTarget,
  async listMedia(target) {
    const { cards, team } = await listCards(target)
    return selectedMedia(target, cards, team)
  },
  async readMedia(target, id) {
    const { card, team } = await readNovelCard(target, id)
    return selectedMedia(target, [card], team)
  },
  async download(target, media, destination) {
    if (!isAbsolute(destination)) throw new Error('需要服务端临时文件的绝对路径')
    const id = nodeId.parse(media.nodeId)
    const data = z
      .object({ nodeId, assetId: nodeId, localPath: z.string() })
      .parse(await command(target, ['node', 'download', '--node-id', id, '--out', destination]))
    if (
      data.nodeId !== id ||
      data.assetId !== media.assetId ||
      resolve(data.localPath) !== resolve(destination)
    )
      throw new Error('即梦短剧下载回执与所选素材不符，请刷新后重试')
  },
  replace: replaceMedia,
}
