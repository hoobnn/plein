/**
 * 测试工具：只给测试用，不从主入口导出（`@plein/doc/testing`）。
 */
import type * as Y from 'yjs'
import { createDoc } from './doc'
import type { NewElement, Rect } from './types'

/** 打开文档，变更通知不自动派发（测试里按需 doc.flush()） */
export const openDoc = (ydoc?: Y.Doc) => createDoc(ydoc, { schedule: () => {} })

/** 100×80 的图片元素 */
export const box = (extra: Partial<NewElement> = {}): NewElement => ({
  kind: 'image',
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  ...extra,
})

/** 一进（in）一出（out）的文本节点 */
export const node = (extra: Partial<NewElement> = {}): NewElement =>
  box({
    kind: 'node',
    nodeType: 'llm',
    ports: {
      inputs: [{ id: 'in', label: '输入', type: 'text' }],
      outputs: [{ id: 'out', label: '输出', type: 'text' }],
    },
    ...extra,
  })

/** 两个矩形有面积重叠（贴边不算） */
export function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
