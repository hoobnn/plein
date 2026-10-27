// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, setParam, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { PromptTools } from './PromptTools'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const node = {
    ...describeNode(
      corePlugin.nodes.find((n) => n.type === 'plein/image')!,
      'plein/core',
    ),
    executable: true,
  }
  const id = createElement(doc, {
    kind: 'node',
    nodeType: node.type,
    params: { prompt: '雨夜天台', model: 'test:image' },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const engine = { doc } as Engine
  useCanvas.setState({ engine, canvasId: 'c' })
  const requests: unknown[] = []
  mockFetch(async (req) => {
    if (req.url.endsWith(`/nodes/${id}/input`)) return Response.json({ params: {}, refs: [] })
    if (req.url.endsWith('/prompt/rewrite')) {
      requests.push(await req.json())
      return Response.json({ text: '优化后的雨夜天台' })
    }
  })
  const catalog = {
    providers: [{ enabled: true, configured: true, models: [{ capabilities: ['text.chat'] }] }],
  } as Catalog
  const rendered = renderApp(
    <PromptTools
      engine={engine}
      elId={id}
      promptKey="prompt"
      text="雨夜天台"
      node={node}
      catalog={catalog}
    />,
  )
  const suggest = async () => {
    await rendered.user.click(screen.getByRole('button', { name: '优化提示词' }))
    await waitFor(() =>
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '建议提示词' }).value).toBe(
        '优化后的雨夜天台',
      ),
    )
  }
  return { doc, id, requests, ...rendered, suggest }
}
it('关闭不写回，编辑建议明确采用后可撤销', async () => {
  const f = setup()
  await f.suggest()
  expect(f.doc.get(f.id)?.params?.prompt).toBe('雨夜天台')
  await f.user.click(screen.getByRole('button', { name: '关闭' }))
  expect(f.doc.get(f.id)?.params?.prompt).toBe('雨夜天台')
  await f.suggest()
  fireEvent.change(screen.getByRole('textbox', { name: '建议提示词' }), {
    target: { value: '人工修订后的天台' },
  })
  await f.user.click(screen.getByRole('button', { name: '采用建议' }))
  expect(f.doc.get(f.id)?.params?.prompt).toBe('人工修订后的天台')
  act(() => {
    f.doc.undo.undo()
  })
  expect(f.doc.get(f.id)?.params?.prompt).toBe('雨夜天台')
  expect(f.requests).toHaveLength(2)
})
it.each(['prompt', 'model'])('协作端修改 %s 后建议不覆盖当前内容', async (key) => {
  const f = setup()
  await f.suggest()
  setParam(f.doc, f.id, key, '协作新值')
  await f.user.click(screen.getByRole('button', { name: '采用建议' }))
  expect(screen.getByRole('alert').textContent).toContain('未覆盖当前内容')
  expect(f.doc.get(f.id)?.params?.[key]).toBe('协作新值')
})
it('只读竞态保留建议并说明恢复方法，恢复后能采用', async () => {
  const f = setup()
  await f.suggest()
  f.doc.readOnly = true
  await f.user.click(screen.getByRole('button', { name: '采用建议' }))
  expect(f.doc.get(f.id)?.params?.prompt).toBe('雨夜天台')
  expect(screen.getByRole('alert').textContent).toContain('恢复编辑权限')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '建议提示词' }).value).toBe(
    '优化后的雨夜天台',
  )
  f.doc.readOnly = false
  await f.user.click(screen.getByRole('button', { name: '采用建议' }))
  expect(f.doc.get(f.id)?.params?.prompt).toBe('优化后的雨夜天台')
})
