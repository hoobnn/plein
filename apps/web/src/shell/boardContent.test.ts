import { createElement, type CanvasElement, type NodeResult } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { textNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { candidatesOf, contentOf, statusOf } from './boardContent'

const catalog: Catalog = {
  nodes: [{ ...describeNode(textNode, 'plein'), executable: true }],
  plugins: [],
  providers: [],
  defaultModels: {},
  templates: [],
  prompts: [],
  elements: [],
}
function node(extra: Partial<CanvasElement> = {}): CanvasElement {
  const doc = openDoc()
  const id = createElement(doc, { kind: 'node', nodeType: 'plein/text', x: 0, y: 0, w: 100, h: 80 })
  const value = { ...doc.get(id)!, ...extra }
  doc.destroy()
  return value
}
const result = (extra: Partial<NodeResult> = {}): NodeResult => ({
  id: 'chosen',
  runId: 'run',
  port: 'text',
  at: 1,
  value: { type: 'text', text: '旧运行结果' },
  ...extra,
})

it.each(['', '  \n\t', '第一行\n第二行'])('手写正文 %j 总是优先于旧结果，空白不计完成', (text) => {
  const el = node({ params: { text }, results: [result()], adopted: 'chosen' })
  expect(contentOf(el, catalog)).toEqual(text.trim() ? { type: 'text', text } : null)
})
it.each(['', ' \n\t', '长正文'.repeat(500)])(
  '生成文本和 Markdown 完成状态由非空正文决定 %j',
  (text) => {
    expect(
      contentOf(
        node({
          nodeType: 'plein/llm',
          results: [result({ value: { type: 'text', text } })],
          adopted: 'chosen',
        }),
        catalog,
      ),
    ).toEqual(text.trim() ? { type: 'text', text } : null)
    expect(contentOf(node({ kind: 'markdown', text }), catalog)).toEqual(
      text.trim() ? { type: 'text', text } : null,
    )
  },
)
it('未采用候选不冒充当前内容；只审片主输出，不混入说明和尾帧', () => {
  const main = result({ port: 'images', value: { type: 'image', assetId: 'image' } })
  const metadata = result({ id: 'metadata', port: 'metadata' })
  const el = node({
    nodeType: 'plein/image',
    ports: { inputs: [], outputs: [{ id: 'images', type: 'image', label: '图片' }] },
    results: [metadata, main],
    adopted: null,
  })
  expect(contentOf(el, catalog)).toBeNull()
  expect(candidatesOf(el)).toEqual([main])
  expect(contentOf({ ...el, adopted: main.id }, catalog)).toEqual({
    type: 'image',
    assetId: 'image',
  })
  expect(contentOf({ ...el, adopted: metadata.id }, catalog)).toEqual({
    type: 'image',
    assetId: 'image',
  })
})
it.each(['image', 'video', 'audio'] as const)('%s 素材保留原文件身份', (kind) => {
  expect(contentOf(node({ kind, assetId: 'original' }), null)).toEqual({
    type: kind,
    assetId: 'original',
  })
})
it.each([
  ['queued', '排队中'],
  ['running', '生成中'],
  ['failed', '失败'],
] as const)('%s 优先于过期提示', (status, label) => {
  expect(statusOf(node({ run: { id: 'run', at: 1, status } }), 'self')?.label).toBe(label)
})
it.each([
  ['self', '需要重跑'],
  ['upstream', '上游已改'],
  ['kept', '已保留'],
] as const)('结束后显示 %s 且提供解释', (stale, label) => {
  const status = statusOf(node({ run: { id: 'run', at: 1, status: 'succeeded' } }), stale)
  expect(status?.label).toBe(label)
  expect(status?.hint).toBeTruthy()
})
it('取消后只对采用同任务结果显示已取回，旧任务结果仍显示已取消', () => {
  const el = node({
    run: { id: 'run', at: 1, status: 'canceled' },
    results: [result()],
    adopted: 'chosen',
  })
  expect(statusOf(el)?.label).toBe('已取回')
  expect(statusOf({ ...el, results: [result({ runId: 'older' })] })?.label).toBe('已取消')
})
