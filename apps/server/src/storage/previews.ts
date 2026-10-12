import { createDoc, currentResult } from '@plein/doc'
import { API, type Canvas } from '@plein/protocol'
import * as Y from 'yjs'
import type { DB } from './db'

const MAX_COVERS = 4

interface Preview {
  updatedAt: number
  covers: string[]
  elements: number
}

/**
 * 首页缩略图：重放文档取最近生成的图片 / 视频（节点结果按时间新到旧，其后是导入的素材），
 * 只用已生成的衍生图（缩略图、视频封面），没有就跳过。按 updated_at 缓存。
 */
export type Previewer = ReturnType<typeof previewer>

export function previewer(db: DB) {
  const cache = new Map<string, Preview>()
  const updates = db.prepare<[string], { data: Buffer }>(
    'SELECT data FROM doc_updates WHERE canvas_id = ? ORDER BY id',
  )
  const variants = db.prepare<[string, string], { variants: string }>(
    'SELECT variants FROM assets WHERE owner_id = ? AND id = ?',
  )

  const compute = (owner: string, id: string): Omit<Preview, 'updatedAt'> => {
    const ydoc = new Y.Doc()
    for (const r of updates.all(id)) Y.applyUpdate(ydoc, new Uint8Array(r.data))
    const doc = createDoc(ydoc, { schedule: () => {} })
    try {
      const generated: Array<{ assetId: string; at: number }> = []
      const imported: string[] = []
      let elements = 0
      for (const el of doc.elements()) {
        elements++
        if (el.kind === 'node') {
          const r = currentResult(el)
          if (r && (r.value.type === 'image' || r.value.type === 'video'))
            generated.push({ assetId: r.value.assetId, at: r.at })
        } else if ((el.kind === 'image' || el.kind === 'video') && el.assetId) {
          imported.push(el.assetId)
        }
      }
      generated.sort((a, b) => b.at - a.at)
      const covers: string[] = []
      for (const assetId of new Set([...generated.map((g) => g.assetId), ...imported])) {
        const row = variants.get(owner, assetId)
        const list: string[] = row ? JSON.parse(row.variants) : []
        const v = list.includes('thumb-1024')
          ? 'thumb-1024'
          : list.includes('poster')
            ? 'poster'
            : null
        if (v) covers.push(API.assetVariant(assetId, v))
        if (covers.length === MAX_COVERS) break
      }
      return { covers, elements }
    } finally {
      doc.destroy()
      ydoc.destroy()
    }
  }

  return (owner: string, c: Canvas): Canvas => {
    let p = cache.get(c.id)
    if (!p || p.updatedAt !== c.updatedAt) {
      try {
        p = { updatedAt: c.updatedAt, ...compute(owner, c.id) }
      } catch {
        // 文档损坏或版本更高时不出缩略图，列表照常返回
        p = { updatedAt: c.updatedAt, covers: [], elements: 0 }
      }
      cache.set(c.id, p)
    }
    return { ...c, covers: p.covers, elements: p.elements }
  }
}
