import { generateNKeysBetween } from 'fractional-indexing'
import * as Y from 'yjs'
import { CONTAINER_KINDS, type Edge } from './types'
import { migrateStoryboardIdentity } from './migrate-storyboard'

/** 当前文档 schema 版本 */
export const SCHEMA_VERSION = 4

export interface MigrateResult {
  version: number
  /** 文档版本高于本客户端：只读打开，不做任何写入 */
  readOnly: boolean
}

type Migration = (ydoc: Y.Doc) => void

/** MIGRATIONS[n] 把 n 版升到 n + 1 版 */
const MIGRATIONS: Migration[] = [v0ToV1, v1ToV2, v2ToV3, migrateStoryboardIdentity]

/**
 * 顺序执行迁移。新文档直接标为当前版本；
 * 没有版本号但已有元素的文档视为 v0（元素整对象存入 Y.Map 的旧格式）。
 */
export function migrate(ydoc: Y.Doc, origin: unknown): MigrateResult {
  const meta = ydoc.getMap<unknown>('meta')
  const elements = ydoc.getMap<unknown>('elements')
  const stored = meta.get('schemaVersion')
  let version = typeof stored === 'number' ? stored : elements.size > 0 ? 0 : SCHEMA_VERSION

  if (version > SCHEMA_VERSION) return { version, readOnly: true }
  if (version === SCHEMA_VERSION && stored === SCHEMA_VERSION) return { version, readOnly: false }

  ydoc.transact(() => {
    while (version < SCHEMA_VERSION) {
      MIGRATIONS[version]!(ydoc)
      version++
    }
    meta.set('schemaVersion', version)
    if (!meta.has('createdAt')) meta.set('createdAt', Date.now())
  }, origin)
  return { version, readOnly: false }
}

interface LegacyElement {
  id: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  assetId?: string
  ports?: unknown
  params?: Record<string, unknown>
}

const LEGACY_KINDS: Record<string, { kind: string; nodeType?: string }> = {
  image: { kind: 'image' },
  video: { kind: 'video' },
  markdown: { kind: 'markdown' },
  group: { kind: 'frame' },
  generator: { kind: 'node', nodeType: 'generator' },
  llm: { kind: 'node', nodeType: 'llm' },
}

/** v0 → v1：整对象元素改为嵌套 Y.Map，旧类型并入 node / frame，补 z 序 */
function v0ToV1(ydoc: Y.Doc) {
  const elements = ydoc.getMap<unknown>('elements')
  const legacy = [...elements.entries()]
    .filter(([, v]) => !(v instanceof Y.Map))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const zs = generateNKeysBetween(null, null, legacy.length)
  legacy.forEach(([id, value], i) => {
    const old = value as LegacyElement
    const mapped = LEGACY_KINDS[old.kind] ?? { kind: 'node', nodeType: old.kind }
    const m = new Y.Map<unknown>()
    m.set('kind', mapped.kind)
    m.set('x', old.x)
    m.set('y', old.y)
    m.set('w', old.w)
    m.set('h', old.h)
    m.set('rotation', 0)
    m.set('z', zs[i]!)
    m.set('parentId', null)
    m.set('locked', false)
    if (mapped.nodeType) {
      m.set('nodeType', mapped.nodeType)
      m.set('nodeVersion', 1)
    }
    if (old.assetId) m.set('assetId', old.assetId)
    if (old.ports) m.set('ports', old.ports)
    if (old.params) m.set('params', new Y.Map(Object.entries(old.params)))
    elements.set(id, m)
  })
}

interface LegacyEdge {
  id: string
  from: [string, string]
  to: [string, string]
}

interface LegacyPorts {
  inputs: Array<{ id: string }>
  outputs: unknown[]
}

/** 旧版生成视频节点的三个图片输入，按这个顺序推断模式 */
const VIDEO_FRAME_PORTS = ['lastFrame', 'firstFrame', 'references'] as const
const VIDEO_MODE = { lastFrame: 'frames', firstFrame: 'image', references: 'reference' } as const

/**
 * v1 → v2：生成视频节点（plein/video@1）的首帧 / 尾帧 / 参考图三个输入并成一个「图片」输入，
 * 怎么用改由参数 mode 指定（首尾帧 / 图生视频 / 图片参考 / 文生视频），节点升到 2 版。
 * 模式按原来连了哪个口推断；旧版按空间位置收集输入，随后 v2 → v3 会将该顺序固化。
 */
function v1ToV2(ydoc: Y.Doc) {
  const elements = ydoc.getMap<unknown>('elements')
  const edges = ydoc.getMap<LegacyEdge>('edges')
  for (const [id, m] of elements) {
    if (!(m instanceof Y.Map) || m.get('nodeType') !== 'plein/video') continue
    if ((m.get('nodeVersion') ?? 1) !== 1) continue
    const into = [...edges.entries()].filter(([, e]) => e.to[0] === id)
    const used = VIDEO_FRAME_PORTS.find((p) => into.some(([, e]) => e.to[1] === p))
    const seen = new Set<string>()
    for (const [key, e] of into) {
      if (!(VIDEO_FRAME_PORTS as readonly string[]).includes(e.to[1])) continue
      const from = e.from.join(':')
      if (seen.has(from)) edges.delete(key)
      else edges.set(key, { ...e, to: [id, 'images'] })
      seen.add(from)
    }
    const ports = m.get('ports') as LegacyPorts | undefined
    if (ports && Array.isArray(ports.inputs)) {
      const inputs = ports.inputs.filter(
        (p) => !(VIDEO_FRAME_PORTS as readonly string[]).includes(p.id),
      )
      inputs.push({ id: 'images', label: '图片', type: 'image', multiple: true } as { id: string })
      m.set('ports', { ...ports, inputs })
    }
    let params = m.get('params')
    if (!(params instanceof Y.Map)) {
      params = new Y.Map<unknown>()
      m.set('params', params)
    }
    ;(params as Y.Map<unknown>).set('mode', used ? VIDEO_MODE[used] : 'text')
    m.set('nodeVersion', 2)
  }
}

/** v2 → v3：只在迁移时按旧世界坐标排序，之后布局不再决定生成输入。 */
function v2ToV3(ydoc: Y.Doc) {
  const elements = ydoc.getMap<Y.Map<unknown>>('elements')
  const edges = ydoc.getMap<Edge>('edges')
  const groups = new Map<string, Edge[]>()
  const positions = new Map<string, { x: number; y: number }>()
  const parentOf = (id: string): string | null => {
    const el = elements.get(id)
    const p = el?.get('parentId')
    const parent = typeof p === 'string' ? elements.get(p) : undefined
    if (!(parent instanceof Y.Map) || !CONTAINER_KINDS.has(parent.get('kind') as 'frame'))
      return null
    const seen = new Set([id])
    let cur: unknown = p
    while (typeof cur === 'string') {
      if (seen.has(cur)) return null
      seen.add(cur)
      cur = elements.get(cur)?.get('parentId')
    }
    return p as string
  }
  const position = (id: string): { x: number; y: number } => {
    const cached = positions.get(id)
    if (cached) return cached
    const el = elements.get(id)
    const p = parentOf(id)
    const offset = p ? position(p) : { x: 0, y: 0 }
    const result = {
      x: Number(el?.get('x') ?? 0) + offset.x,
      y: Number(el?.get('y') ?? 0) + offset.y,
    }
    positions.set(id, result)
    return result
  }
  for (const edge of edges.values()) {
    const key = JSON.stringify(edge.to)
    const list = groups.get(key) ?? []
    list.push(edge)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    // JS stable sort 保持坐标相同时旧 Y.Map 的遍历顺序。
    list.sort(
      (a, b) =>
        position(a.from[0]).y - position(b.from[0]).y ||
        position(a.from[0]).x - position(b.from[0]).x,
    )
    const keys = generateNKeysBetween(null, null, list.length)
    list.forEach((edge, i) => edges.set(edge.id, { ...edge, order: keys[i]! }))
  }
}
