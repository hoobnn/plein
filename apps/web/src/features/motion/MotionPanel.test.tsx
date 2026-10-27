// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { addResults, createDoc, createElement } from '@plein/doc'
import { MotionParams } from '@plein/nodes'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { watchMotionHistory } from './history'
import { MotionPanel } from './MotionPanel'

// 此文件验证编辑与写入；隔离播放器协议由 MotionPreview.test.tsx 独立验证。
vi.mock('./MotionPreview', () => ({ MotionPreview: () => <div aria-label="预览边界" /> }))
resetStoreAfterEach(useCatalog)
const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))
function setup() {
  const doc = createDoc(undefined, { schedule: () => {} })
  const off = watchMotionHistory(doc)
  cleanup.push(() => {
    off()
    doc.destroy()
  })
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/motion',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    params: MotionParams.parse({}),
  })
  const engine = {
    doc,
    onStateChange: () => () => {},
    selection: { onChange: () => () => {}, set: vi.fn() },
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas', motion: id })
  const view = renderApp(<MotionPanel engine={engine} id={id} onClose={() => {}} />)
  const readonly = (value: boolean) =>
    act(() => {
      doc.readOnly = value
      doc.mutable(id)!.set('name', value ? '只读' : '可写')
      doc.flush()
    })
  return { ...view, doc, id, readonly }
}
it('真实SDK编辑一次提交，撤销重做保持唯一历史，未渲染不产生候选', async () => {
  const f = setup()
  const title = screen.getByRole('textbox', { name: '标题文案' })
  await waitFor(() => expect((title as HTMLInputElement).disabled).toBe(false))
  await f.user.clear(title)
  await f.user.type(title, '测试标题')
  expect(f.doc.get(f.id)!.params!.overrides).toEqual({})
  await f.user.tab()
  await waitFor(() =>
    expect(f.doc.get(f.id)!.params!.overrides).toMatchObject({ 'hf-title.text': '测试标题' }),
  )
  act(() => f.doc.flush())
  await f.user.click(screen.getByRole('button', { name: '撤销动态合成编辑' }))
  act(() => f.doc.flush())
  expect(f.doc.get(f.id)!.params!.overrides).toEqual({})
  await f.user.click(screen.getByRole('button', { name: '重做动态合成编辑' }))
  act(() => f.doc.flush())
  expect(f.doc.get(f.id)!.params!.overrides).toMatchObject({ 'hf-title.text': '测试标题' })
  expect(f.doc.get(f.id)!.results ?? []).toEqual([])
  f.unmount()
  await act(async () => {})
})
it('透明WebM输出持久到文档；只读拒绝格式/渲染/采用并清除未提交字段草稿', async () => {
  const f = setup()
  const format = screen.getByRole('combobox', { name: '动态合成输出格式' })
  await f.user.click(format)
  await f.user.click(screen.getByRole('option', { name: '透明 WebM（叠加素材）' }))
  expect(f.doc.get(f.id)!.params!.output).toBe('transparent-webm')
  const title = screen.getByRole('textbox', { name: '标题文案' }) as HTMLInputElement
  await waitFor(() => expect(title.disabled).toBe(false))
  const original = title.value
  await f.user.clear(title)
  await f.user.type(title, '不保存的草稿')
  f.readonly(true)
  expect(title.closest('fieldset')!.disabled).toBe(true)
  expect(title.value).toBe(original)
  expect((format as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '渲染为候选' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  f.readonly(false)
  expect(title.value).toBe(original)
  act(() => {
    addResults(
      f.doc,
      f.id,
      [
        {
          id: 'candidate',
          runId: 'run',
          port: 'video',
          at: 1,
          value: { type: 'video', assetId: 'a'.repeat(64) },
        },
      ],
      { adopt: false },
    )
    f.doc.flush()
  })
  const adopt = screen.getByRole('button', { name: '采用' })
  f.readonly(true)
  expect((adopt as HTMLButtonElement).disabled).toBe(true)
  f.readonly(false)
  await f.user.click(adopt)
  expect(f.doc.get(f.id)!.adopted).toBe('candidate')
  f.unmount()
  await act(async () => {})
})
