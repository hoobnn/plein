// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
} from '../../testing/render'
import { RecipeLibrary } from './RecipeLibrary'
resetStoreAfterEach(useCatalog)
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
    nodeVersion: node.version,
    params: { prompt: '手写草稿', model: 'chosen:model' },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const preset = {
    id: 'plein/three-view',
    plugin: 'plein/core',
    title: '角色三视图',
    template: '【角色】三视图',
    appliesTo: ['image.generate'],
  }
  const catalog = {
    nodes: [node],
    prompts: [preset],
    plugins: [{ id: 'plein/core', name: '内置', version: '1' }],
    providers: [],
  } as unknown as Catalog
  const engine = { doc, selection: { set: vi.fn() } } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'c' })
  useCatalog.setState({ catalog })
  let reads = 0,
    finish!: (response: Response) => void
  mockFetch((req) => {
    if (req.url.endsWith('/api/catalog')) {
      reads++
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    }
  })
  const rendered = renderApp(<RecipeLibrary engine={engine} el={doc.get(id)!} node={node} />)
  const open = () => rendered.user.click(screen.getByRole('button', { name: '创作配方' }))
  const apply = () =>
    rendered.user.click(screen.getByRole('button', { name: '套用「角色三视图」到草稿' }))
  return {
    ...rendered,
    doc,
    id,
    catalog,
    open,
    apply,
    reads: () => reads,
    finish: (response = Response.json(catalog)) =>
      act(async () => {
        finish(response)
        await Promise.resolve()
      }),
  }
}
it('可搜索并显示输入说明，等待不重复核对，采用保留模型且一次撤销', async () => {
  const f = setup()
  await f.open()
  expect(screen.getByText('结构示意 · 非生成效果')).toBeTruthy()
  const search = screen.getByRole('textbox', { name: '搜索创作配方' })
  fireEvent.change(search, { target: { value: '不存在' } })
  expect(screen.getByText('没有匹配的配方，试试其他关键词。')).toBeTruthy()
  fireEvent.change(search, { target: { value: '三视图' } })
  await f.apply()
  expect(screen.getByRole('status').textContent).toContain('正在核对配方')
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: '套用「角色三视图」到草稿' }).disabled,
  ).toBe(true)
  expect(f.reads()).toBe(1)
  await f.finish()
  await waitFor(() => expect(f.doc.get(f.id)?.params?.prompt).toBe('【角色】三视图'))
  expect(f.doc.get(f.id)?.params?.model).toBe('chosen:model')
  expect(f.doc.get(f.id)?.run).toBeUndefined()
  act(() => {
    f.doc.undo.undo()
  })
  expect(f.doc.get(f.id)?.params?.prompt).toBe('手写草稿')
})
it.each(['removed', 'changed', 'failed'] as const)(
  '最新目录 %s 不改写草稿并可重试',
  async (mode) => {
    const f = setup()
    await f.open()
    await f.apply()
    await f.finish(
      mode === 'failed'
        ? Response.json({ message: '目录暂不可用' }, { status: 503 })
        : Response.json({
            ...f.catalog,
            prompts: mode === 'removed' ? [] : [{ ...f.catalog.prompts[0], template: '新版' }],
          }),
    )
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        mode === 'failed' ? '目录读取失败' : '目录已变化',
      ),
    )
    expect(f.doc.get(f.id)?.params?.prompt).toBe('手写草稿')
    await f.apply()
    await f.finish()
    await waitFor(() => expect(f.doc.get(f.id)?.params?.prompt).toBe('【角色】三视图'))
  },
)
it.each(['reopen', 'leave'] as const)('核对迟到时 %s 不应用旧选择', async (departure) => {
  const f = setup()
  await f.open()
  await f.apply()
  if (departure === 'reopen') {
    await f.user.keyboard('{Escape}')
    await f.open()
  } else act(() => useCanvas.setState({ canvasId: 'other' }))
  await f.finish()
  await waitFor(() => expect(f.reads()).toBe(1))
  expect(f.doc.get(f.id)?.params?.prompt).toBe('手写草稿')
  if (departure === 'reopen') expect(screen.getByRole('dialog', { name: '创作配方' })).toBeTruthy()
})
