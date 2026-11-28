import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runCli } from './cli'
const binary = 'dreamina-canvas'
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
export const nodeId = z.string().regex(/^node_[A-Za-z0-9_-]{1,128}$/)
const revision = z.number().int().nonnegative()
const envelope = z.object({ ok: z.literal(true), data: z.unknown() })
const pageSchema = z.object({
  projectId: z.string(),
  items: z.array(z.object({ nodeId })),
  draftVersion: revision,
  total: revision,
  hasMore: z.boolean(),
  offset: revision,
})
export const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() })
export const readableRef = z.object({
  kind: z.string(),
  id: z.string().optional(),
  title: z.string().optional(),
})
const nodeSchema = z.object({
  subjectBindings: z
    .object({
      main: readableRef.optional(),
      voice: readableRef.optional(),
      auxiliaries: z.array(readableRef).optional(),
    })
    .optional(),
  timelineTracks: z
    .object({
      tracks: z.array(
        z.object({ kind: z.string(), clips: z.array(z.object({ source: readableRef })) }),
      ),
      clipsTruncated: z.boolean().optional(),
    })
    .optional(),
  parentNodeId: z.string().optional(),
  resources: z
    .array(
      z.object({
        resourceId: z.string(),
        type: z.string(),
        status: z.string(),
        name: z.string().optional(),
      }),
    )
    .optional(),
  layout: positionSchema.optional(),
  projectId: z.string().optional(),
  nodeId,
  type: z.string().min(1),
  title: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
  generation: z.object({ prompt: z.string().optional() }).passthrough().optional(),
})
const showSchema = z.object({
  projectId: z.string().optional(),
  draftVersion: revision,
  nodes: z.array(
    z.object({ nodeId: nodeId.optional(), result: z.string(), node: nodeSchema.optional() }),
  ),
})
export const mutationSchema = z.object({ node: nodeSchema })
export type DraftNode = z.infer<typeof nodeSchema>

export const changed = () => new Error('即梦画布在读取期间发生变化，请刷新预览。')

export async function call(args: string[]): Promise<unknown> {
  const raw = await runCli(binary, [...args, '--non-interactive', '--format', 'json'])
  return envelope.parse(JSON.parse(raw)).data
}

export function checkTarget(target: string) {
  if (!uuid.test(target))
    throw new Error('请输入即梦全能画布的项目 UUID，可通过 dreamina-canvas canvas ls 查看。')
}

export function checkProject(actual: string | undefined, expected: string) {
  if (actual !== undefined && actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('即梦 CLI 返回了其他画布的数据，请重新选择画布。')
  }
}

export async function readNodes(target: string, ids: string[], version?: number) {
  const detail = showSchema.parse(
    await call([
      'node',
      'show',
      '--project-id',
      target,
      ...ids.flatMap((id) => ['--node-id', nodeId.parse(id)]),
    ]),
  )
  checkProject(detail.projectId, target)
  if (version !== undefined && detail.draftVersion !== version) throw changed()
  const wanted = new Set(ids)
  const nodes = detail.nodes.map((row) => {
    const node = row.node
    if (
      row.result.toUpperCase() !== 'FOUND' ||
      !node ||
      !wanted.delete(node.nodeId) ||
      (row.nodeId && row.nodeId !== node.nodeId)
    )
      throw changed()
    checkProject(node.projectId, target)
    return node
  })
  if (wanted.size) throw changed()
  return nodes
}

export async function supportsPosition() {
  const help = await runCli(binary, ['node', 'edit', 'text', '--help'])
  return /^\s+--x\s/m.test(help) && /^\s+--y\s/m.test(help)
}

const projectsSchema = z.object({
  items: z.array(z.object({ projectId: z.string().regex(uuid), name: z.string() })),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
})

export async function projects() {
  const result = new Map<string, string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = projectsSchema.parse(
      await call(['canvas', 'ls', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]),
    )
    for (const item of page.items) result.set(item.projectId, item.name)
    if (!page.hasMore) return Array.from(result, ([id, title]) => ({ id, title }))
    cursor = page.nextCursor
    if (!cursor || cursors.has(cursor)) throw new Error('即梦画布目录分页异常，请刷新列表。')
    cursors.add(cursor)
  }
}

async function listNodeIndex(target: string) {
  checkTarget(target)
  // Public 1.0.2 uses 'find', while 1.5.0 uses 'ls'. Discover the installed
  // verb locally, so a failed network or access check never triggers a fallback.
  const help = await runCli(binary, ['node', '--help'])
  const verb = help.match(/^\s+(ls|find)\s+/m)?.[1]
  if (!verb) throw new Error('当前 dreamina-canvas 缺少节点列表命令，请升级官方 CLI。')
  let version: number | undefined
  let total: number | undefined
  const ids = new Set<string>()
  for (;;) {
    const offset = ids.size
    if (offset > 1000) throw new Error('此画布超过即梦 CLI 可完整读取的分页范围。')
    const page = pageSchema.parse(
      await call([
        'node',
        verb,
        '--project-id',
        target,
        '--limit',
        '50',
        '--offset',
        String(offset),
      ]),
    )
    checkProject(page.projectId, target)
    if (
      (version !== undefined && version !== page.draftVersion) ||
      (total !== undefined && total !== page.total) ||
      page.offset !== offset
    )
      throw changed()
    version = page.draftVersion
    total = page.total
    for (const row of page.items) {
      if (ids.has(row.nodeId)) throw changed()
      ids.add(row.nodeId)
    }
    if (!page.hasMore) {
      if (ids.size !== total) throw changed()
      break
    }
    if (!page.items.length || ids.size >= total) throw changed()
  }
  return { ids, version }
}

export async function findNodeById(target: string, id: string) {
  const { ids, version } = await listNodeIndex(target)
  if (!ids.has(id)) return undefined
  return (await readNodes(target, [id], version))[0]
}

export async function listNodes(target: string): Promise<DraftNode[]> {
  const { ids, version } = await listNodeIndex(target)
  const ordered = [...ids]
  const nodes: DraftNode[] = []
  for (let i = 0; i < ordered.length; i += 20) {
    nodes.push(...(await readNodes(target, ordered.slice(i, i + 20), version)))
  }
  return nodes
}

export function jimengCreateNodeId(operationId: string) {
  if (!uuid.test(operationId)) throw new Error('即梦节点创建需要稳定的操作 UUID。')
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
  const bytes = createHash('sha256').update(operationId.toLowerCase()).digest()
  return 'node_' + Array.from(bytes.subarray(0, 10), (byte) => alphabet[byte & 31]).join('')
}

export const resourceId = z
  .string()
  .refine((id) => uuid.test(id) || /^resource_[1-9]\d*(?:-\d+)?$/.test(id))
