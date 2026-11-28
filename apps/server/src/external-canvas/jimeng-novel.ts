import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ExternalSpaceId } from '@plein/protocol'
import { parseNovelTarget } from './targets'
import { runCli } from './cli'
import type { CanvasProvider, RemoteItem } from './provider'

export const nodeId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_$.-]{0,159}$/, '即梦短剧返回的节点 ID 无效')
const teamId = z.union([
  ExternalSpaceId,
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String),
])
const envelope = z.object({
  status: z.string(),
  data: z.unknown().optional(),
  context: z
    .object({
      projectId: z.string().nullish(),
      teamId: teamId.nullish(),
    })
    .optional(),
  error: z.object({ code: z.string().optional() }).nullish(),
})
const card = z.object({
  nodeId,
  type: z.string().min(1),
  key: z.string().nullish(),
  name: z.string().nullish(),
  status: z.string().nullish(),
  selectedAssetId: z.string().nullish(),
  config: z.object({
    name: z.string().nullish(),
    viewName: z.string().nullish(),
    description: z.string().nullish(),
    text: z.string().nullish(),
    generation: z
      .object({ prompt: z.string().nullish(), references: z.array(z.unknown()).nullish() })
      .nullish(),
  }),
})
export type NovelCard = z.infer<typeof card>
const page = z.object({ items: z.array(card), nextCursor: z.string().nullish() })
const savedCard = z.object({
  nodeId,
  key: z.string().nullish(),
  config: card.shape.config.extend({ type: z.string() }),
  state: z
    .object({ status: z.string().nullish(), selectedAssetId: z.string().nullish() })
    .nullish(),
})
const projectPage = z.object({
  items: z.array(z.object({ projectId: z.string().regex(/^[1-9]\d{0,19}$/), name: z.string() })),
  nextCursor: z.string().nullish(),
})

export async function invoke(target: string | undefined, args: string[], explicitSpace?: string) {
  const location = target !== undefined ? parseNovelTarget(target) : undefined
  if (
    explicitSpace !== undefined &&
    location?.teamId !== undefined &&
    location.teamId !== explicitSpace
  )
    throw new Error('短剧项目与素材空间不一致')
  const space = ExternalSpaceId.optional().parse(explicitSpace ?? location?.teamId)
  const raw = await runCli('jimeng-novel', [
    ...args,
    ...(location ? ['--project-id', location.projectId] : []),
    ...(space !== undefined ? ['--team-id', space] : []),
    '--full',
    '-j',
  ])
  const result = envelope.parse(JSON.parse(raw))
  if (result.status !== 'success' && result.status !== 'ok')
    throw new Error(`即梦短剧命令未完成（${result.error?.code ?? result.status}）`)
  const actual = result.context
  if (
    location &&
    (location.teamId !== undefined || actual?.projectId != null) &&
    actual?.projectId !== location.projectId
  )
    throw new Error('即梦短剧返回了其他项目或无法确认目标项目，请重新选择画布')
  if (space !== undefined && actual?.teamId !== space)
    throw new Error('即梦短剧未确认目标空间，请重新核对')
  const confirmedTeam =
    location && actual?.projectId === location.projectId ? (actual.teamId ?? undefined) : undefined
  return { data: result.data, confirmedTeam }
}

export async function resolveNovelTarget(target: string): Promise<string> {
  const location = parseNovelTarget(target)
  if (location.teamId !== undefined) return target
  const { confirmedTeam } = await invoke(target, ['node', 'list', '--limit', '1'])
  return confirmedTeam === undefined ? target : confirmedTeam + '/' + location.projectId
}

export async function command(target: string | undefined, args: string[], space?: string) {
  return (await invoke(target, args, space)).data
}

const media = new Set(['image', 'video', 'audio'])
export function toItem(n: z.infer<typeof card>): RemoteItem {
  const config = n.config
  const description = n.type === 'role' || n.type === 'scene'
  const title =
    (n.type === 'scene' ? config.viewName : undefined) ?? config.name ?? n.name ?? n.key ?? ''
  const text = description
    ? config.description
    : n.type === 'text'
      ? config.text
      : config.generation?.prompt
  return {
    id: n.nodeId,
    ...(n.key?.match(/^plein\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)
      ? { operationId: n.key.slice(6).toLowerCase() }
      : {}),
    kind: n.type,
    fields: { title, text: text ?? '' },
    editable: (description || n.type === 'text' || media.has(n.type)) && n.status !== 'running',
  }
}

// Large scripts can exceed the OS argument limit. The CLI reads only this generated file.
export async function save(
  target: string,
  args: string[],
  input: Record<string, unknown>,
  prompt?: string,
) {
  parseNovelTarget(target)
  const directory = await mkdtemp(join(tmpdir(), 'plein-drama-'))
  try {
    if (Object.keys(input).length) {
      const path = join(directory, 'card.json')
      await writeFile(path, JSON.stringify(input), { mode: 0o600 })
      args.push('--input-file', path)
    }
    // The CLI's single-field prompt flag retains references, model and parameters.
    // Use the literal flag for an empty prompt: the CLI may reject an empty Markdown file.
    if (prompt === '') args.push('--prompt', '')
    else if (prompt !== undefined) {
      const path = join(directory, 'prompt.md')
      await writeFile(path, prompt, { mode: 0o600 })
      args.push('--prompt-file', path)
    }
    return await command(target, args)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function equal(a: RemoteItem['fields'], b: RemoteItem['fields']) {
  return a.title === b.title && a.text === b.text
}

async function pages<T extends { id: string }>(
  read: (cursor: string[]) => Promise<{ items: T[]; nextCursor?: string | null }>,
): Promise<T[]> {
  const items: T[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const data = await read(cursor ? ['--cursor', cursor] : [])
    for (const row of data.items) {
      if (ids.has(row.id)) throw new Error('即梦短剧分页内容发生变化，请重新读取')
      ids.add(row.id)
      items.push(row)
    }
    cursor = data.nextCursor || undefined
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('即梦短剧返回了重复的分页游标，请重新读取')
      cursors.add(cursor)
    }
  } while (cursor)
  return items
}

export function projectsInSpace(space?: string) {
  return pages(async (cursor) => {
    const data = projectPage.parse(
      await command(undefined, ['canvas', 'list', '--limit', '100', ...cursor], space),
    )
    return {
      items: data.items.map((row) => ({ id: row.projectId, title: row.name })),
      nextCursor: data.nextCursor,
    }
  })
}

export async function novelProjects(space?: string) {
  const projects = await projectsInSpace(space)
  return space === undefined
    ? projects
    : projects.map((row) => ({ ...row, id: space + '/' + row.id }))
}

const spaces = z.object({
  spaces: z.array(z.object({ team_id: teamId, name: z.string(), current: z.boolean() })),
})
export async function novelSpaces() {
  const { spaces: rows } = spaces.parse(await command(undefined, ['space', 'list']))
  if (new Set(rows.map((row) => row.team_id)).size !== rows.length)
    throw new Error('即梦短剧空间列表存在重复 ID，请重新读取')
  return rows.map((row) => ({ id: row.team_id, title: row.name, current: row.current }))
}

export async function listCards(target: string, filter: string[] = []) {
  parseNovelTarget(target)
  const teams = new Set<string>()
  const cards = await pages(async (cursor) => {
    const result = await invoke(target, [
      'node',
      'list',
      '--config',
      '--limit',
      '100',
      ...filter,
      ...cursor,
    ])
    teams.add(result.confirmedTeam ?? '')
    const data = page.parse(result.data)
    return { items: data.items.map((n) => ({ ...n, id: n.nodeId })), nextCursor: data.nextCursor }
  })
  if (teams.size > 1) throw new Error('读取短剧分页期间空间发生变化，请重新读取')
  return { cards, team: [...teams][0] || undefined }
}

// Some CDN links rotate their access signature between two consecutive reads.
function referenceIdentity(ref: unknown) {
  if (typeof ref !== 'string' || !/^https?:\/\//i.test(ref)) return ref ?? null
  let url
  try {
    url = new URL(ref)
  } catch {
    return ref
  }
  for (const name of [...url.searchParams.keys()]) {
    if (
      /^(?:x-(?:amz|tos)-(?:algorithm|credential|date|expires|security-token|signature|signedheaders)|(?:x-)?(?:expires|signature)|key-pair-id|policy)$/i.test(
        name,
      )
    )
      url.searchParams.delete(name)
  }
  url.searchParams.sort()
  return url.toString()
}

// References drive generation. A stale or manually drawn visual edge does not establish a binding.
function projectCards(cards: z.infer<typeof card>[]): RemoteItem[] {
  const keys = new Map<string, string | null>()
  for (const n of cards) {
    if (n.key) keys.set(n.key, keys.has(n.key) ? null : n.nodeId)
  }
  return cards.map((n) => {
    const item = toItem(n)
    const refs = n.config.generation?.references
    if (n.type === 'text' || !refs?.length) return item
    const hash = createHash('sha256')
    const references = refs.map((raw, index) => {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      hash.update(
        JSON.stringify([r.name ?? null, referenceIdentity(r.ref), r.usage ?? 'reference']),
      )
      const alias = typeof r.name === 'string' ? r.name.trim() : ''
      // A fallback also covers legacy rows whose name is a signed link or a local path.
      const label =
        alias && alias.length <= 120 && !/[\p{C}:/\\?=&]/u.test(alias)
          ? alias
          : '参考 ' + (index + 1)
      const usage =
        r.usage === 'firstFrame' || r.usage === 'lastFrame' || r.usage === 'reference'
          ? r.usage
          : r.usage == null
            ? 'reference'
            : 'unknown'
      const sourceId =
        typeof r.ref === 'string' && r.ref.startsWith('node:')
          ? keys.get(r.ref.slice(5))
          : undefined
      return { label, usage, ...(sourceId ? { sourceId } : {}) }
    })
    return { ...item, references, referenceRevision: hash.digest('hex') }
  })
}

function receiptCard(data: unknown): NovelCard {
  const node = savedCard.parse(data)
  return {
    ...node,
    type: node.config.type,
    status: node.state?.status,
    selectedAssetId: node.state?.selectedAssetId,
  }
}

function receipt(data: unknown): RemoteItem {
  return projectCards([receiptCard(data)])[0]!
}

export async function readNovelCard(target: string, id: string) {
  const res = await invoke(target, ['node', 'get', '--node-id', nodeId.parse(id)])
  const card = receiptCard(res.data)
  if (card.nodeId !== id) throw new Error('即梦短剧返回的节点 ID 与所选节点不符')
  return { card, team: res.confirmedTeam }
}

async function read(target: string, id: string): Promise<RemoteItem> {
  return projectCards([(await readNovelCard(target, id)).card])[0]!
}

export const jimengNovel: CanvasProvider = {
  resolveTarget: resolveNovelTarget,
  spaces: novelSpaces,
  projects: novelProjects,
  read,
  list: async (target) => projectCards((await listCards(target)).cards),
  createKinds: ['text', 'role', 'scene', 'image', 'video'],

  async update(target, item, fields) {
    parseNovelTarget(target)
    const id = nodeId.parse(item.id)
    if (!item.editable) throw new Error('当前短剧节点无法更新')
    const args = ['--node-id', id]
    const latest = await read(target, id)
    if (latest.id !== id || latest.kind !== item.kind) throw new Error('即梦短剧节点已变更，请刷新')
    if (equal(latest.fields, fields)) return
    if (!latest.editable) throw new Error('当前短剧节点无法更新')
    if (!equal(latest.fields, item.fields) || latest.referenceRevision !== item.referenceRevision)
      throw new Error('即梦短剧节点或生成参考已被编辑，请刷新后核对')
    let prompt: string | undefined
    const input: Record<string, unknown> = {}
    if (fields.title !== item.fields.title) {
      if (item.kind === 'scene') input.viewName = fields.title
      else input.name = fields.title
    }
    if (fields.text !== item.fields.text) {
      if (item.kind === 'role' || item.kind === 'scene') input.description = fields.text
      else if (item.kind === 'text') input.text = fields.text
      else if (media.has(item.kind)) prompt = fields.text
      else throw new Error('未知的即梦短剧节点类型')
    }
    if (!Object.keys(input).length && prompt === undefined) return
    const result = receipt(await save(target, ['node', 'update', ...args], input, prompt))
    if (result.id !== id || !equal(result.fields, fields))
      throw new Error('即梦短剧未确认保存内容，请重新读取')
  },

  async create(target, fields, operationId, kind = 'text') {
    if (!jimengNovel.createKinds?.includes(kind)) throw new Error('当前类型无法创建为短剧节点')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)) throw new Error('创建操作 ID 无效')
    const key = 'plein/' + operationId
    const existing = (await listCards(target, ['--key', key])).cards
    if (existing.length) {
      const node = existing[0]!
      const item = toItem(node)
      if (
        existing.length === 1 &&
        node.key === key &&
        item.kind === kind &&
        equal(item.fields, fields)
      )
        return item.id
      throw new Error('即梦短剧已有相同创建键，内容不同，请核对该节点')
    }
    const input: Record<string, unknown> = { name: fields.title }
    let prompt: string | undefined
    if (kind === 'scene') input.viewName = fields.title
    if (kind === 'scene' || kind === 'role') input.description = fields.text
    else if (kind === 'text') input.text = fields.text
    else if (fields.text) prompt = fields.text
    const data = savedCard
      .extend({ key: z.literal(key) })
      .parse(await save(target, ['node', 'create', '--type', kind, '--key', key], input, prompt))
    if (data.config.type !== kind || !equal(receipt(data).fields, fields))
      throw new Error('即梦短剧创建回执与预期不符，请刷新')
    return data.nodeId
  },
}
