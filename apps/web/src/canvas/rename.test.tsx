// @vitest-environment happy-dom
import { createElement, deleteElements, updateElement } from '@plein/doc'
import { openDoc, node } from '@plein/doc/testing'
import { afterEach, expect, it } from 'vite-plus/test'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { mediaTestEngine } from '../shell/media-tools/testEngine'
import { useCanvas } from '../stores/canvas'
import { requestElementRename } from './rename'

const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(doc, node({ nodeType: 'plein/character', name: '林夏' }))
  const prompt = createElement(doc, node({ params: { prompt: '@林夏 微笑' } }))
  const engine = mediaTestEngine(doc)
  useCanvas.setState({ engine })
  const f = renderApp(<div />)
  act(() => {
    void requestElementRename(engine, id)
  })
  return { ...f, doc, id, prompt }
}
it('保存后同步引用；取消不写入', async () => {
  const f = setup()
  const input = await screen.findByRole('textbox', { name: '重命名节点' })
  await f.user.clear(input)
  await f.user.type(input, '小夏')
  await f.user.click(screen.getByRole('button', { name: '保存并同步引用' }))
  await waitFor(() => expect(f.doc.get(f.id)?.name).toBe('小夏'))
  expect(f.doc.get(f.prompt)?.params?.prompt).toBe('@小夏 微笑')
})
it.each(['switch', 'deleted', 'renamed', 'readonly'] as const)(
  '对话框打开后 %s 不能覆盖或部分写入',
  async (change) => {
    const f = setup()
    const input = await screen.findByRole('textbox', { name: '重命名节点' })
    await f.user.clear(input)
    await f.user.type(input, '我的输入')
    act(() => {
      if (change === 'switch') useCanvas.setState({ engine: null })
      if (change === 'deleted') deleteElements(f.doc, [f.id])
      if (change === 'renamed') updateElement(f.doc, f.id, { name: '同伴的名字' })
      if (change === 'readonly') f.doc.readOnly = true
    })
    await f.user.click(screen.getByRole('button', { name: '保存并同步引用' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('我的输入')
    expect(f.doc.get(f.prompt)?.params?.prompt).toBe('@林夏 微笑')
    expect(f.doc.get(f.id)?.name).not.toBe('我的输入')
  },
)
it('取消保留原名称及引用', async () => {
  const f = setup()
  const input = await screen.findByRole('textbox', { name: '重命名节点' })
  await f.user.clear(input)
  await f.user.type(input, '未保存的名字')
  await f.user.keyboard('{Escape}')
  expect(f.doc.get(f.id)?.name).toBe('林夏')
  expect(f.doc.get(f.prompt)?.params?.prompt).toBe('@林夏 微笑')
})
