import { generateNKeysBetween } from 'fractional-indexing'
import * as Y from 'yjs'

/** 当前文档 schema 版本 */
export const SCHEMA_VERSION = 1

export interface MigrateResult {
  version: number
  /** 文档版本高于本客户端：只读打开，不做任何写入 */
  readOnly: boolean
}

type Migration = (ydoc: Y.Doc) => void

/** MIGRATIONS[n] 把 n 版升到 n + 1 版 */
const MIGRATIONS: Migration[] = [v0ToV1]

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
