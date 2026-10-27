// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  createElement,
  deleteElements,
  type NodeResult,
  type PleinDoc,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { act, fireEvent, renderApp, screen } from '../testing/render'
import { Viewer } from './Viewer'
import { shellFixture } from './testing'

function setup(kind: 'image' | 'video' | 'audio' | 'text' = 'image', count = 4) {
  const f = shellFixture()
  const id = f.add(kind === 'audio' ? 'speech' : kind === 'text' ? 'llm' : kind, '审片素材')
  const results = f.results(id, kind, count)
  useCanvas.setState({
    viewer: { kind: 'result', nodeId: id, resultId: results[0]!.id, name: '审片素材' },
  })
  const rendered = renderApp(<Viewer />)
  const group = () => screen.getByRole('group', { name: '候选审片操作' })
  const image = () => screen.getByRole('img', { name: /审片素材|候选 A/ })
  const update = (rows: NodeResult[]) =>
    act(() => {
      f.doc.mutable(id)!.set('results', rows)
      f.doc.flush()
    })
  return { ...f, ...rendered, id, results, group, image, update }
}

it.each(['removed', 'inserted', 'rapid'] as const)(
  '浏览 %s 使用实时同端口候选，连续操作不丢步且不采用',
  async (mode) => {
    const f = setup()
    const next = screen.getByRole('button', { name: '预览下一个候选' })
    act(() => {
      if (mode === 'removed')
        f.doc.mutable(f.id)!.set('results', [f.results[0], ...f.results.slice(2)])
      if (mode === 'inserted')
        f.doc
          .mutable(f.id)!
          .set('results', [
            f.results[0],
            { ...f.results[0]!, id: 'metadata', port: 'metadata' },
            { ...f.results[3]!, id: 'inserted' },
            ...f.results.slice(1),
          ])
      next.click()
      if (mode === 'rapid') next.click()
      f.doc.flush()
    })
    expect(f.image().getAttribute('src')).toContain(`${f.id}-asset-${mode === 'inserted' ? 3 : 2}`)
    expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
  },
)
it.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'keyCode'] as const)(
  '%s 浏览与 Enter 不误采用',
  (key) => {
    const f = setup()
    fireEvent.keyDown(f.group(), { key: 'ArrowRight', [key]: key === 'keyCode' ? 229 : true })
    expect(f.image().getAttribute('src')).toContain(`${f.id}-asset-0`)
    fireEvent.keyDown(f.group(), { key: 'ArrowRight' })
    fireEvent.keyDown(f.group(), { key: 'Enter', [key]: key === 'keyCode' ? 229 : true })
    expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
  },
)
it('控件内方向键不浏览、按钮 Enter 不采用，审片区 Enter 明确采用', async () => {
  const f = setup()
  fireEvent.keyDown(f.group(), { key: 'ArrowRight' })
  await f.user.selectOptions(screen.getByRole('combobox', { name: '对比候选' }), f.results[2]!.id)
  await f.user.selectOptions(screen.getByRole('combobox', { name: '对比方式' }), 'slider')
  fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' })
  expect(f.image().getAttribute('src')).toContain(`${f.id}-asset-1`)
  const zoom = screen.getByRole('button', { name: '放大图片' })
  zoom.focus()
  await f.user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '重置图片视图' }).textContent).toBe('125%')
  expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
  fireEvent.keyDown(f.group(), { key: 'Enter' })
  expect(f.doc.get(f.id)!.adopted).toBe(f.results[1]!.id)
})
it('正文接收阅读按键和全选，不浏览或采用', () => {
  const f = setup('text')
  const text = screen.getByRole('textbox', { name: '候选正文' })
  fireEvent.keyDown(text, { key: 'ArrowRight' })
  fireEvent.keyDown(text, { key: 'Enter' })
  fireEvent.keyDown(text, { key: 'a', ctrlKey: true })
  expect(window.getSelection()?.toString()).toBe('正文 0')
  expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
})
it.each(['removed', 'replaced', 'deleted', 'readonly'] as const)(
  '旧操作 %s 拒绝写入并显示可恢复原因',
  async (mode) => {
    const f = setup()
    await f.user.click(screen.getByRole('button', { name: '预览下一个候选' }))
    const button = screen.getByRole('button', {
      name: mode === 'deleted' ? '定位来源' : '采用此候选',
    })
    act(() => {
      if (mode === 'deleted') {
        f.doc.undo.stopCapturing()
        deleteElements(f.doc, [f.id])
      } else if (mode === 'readonly') f.doc.readOnly = true
      else
        f.doc
          .mutable(f.id)!
          .set(
            'results',
            mode === 'removed'
              ? [f.results[0]]
              : [f.results[0], { ...f.results[1]!, value: f.results[0]!.value }],
          )
      button.click()
      f.doc.flush()
    })
    expect(screen.getByRole('alert').textContent).toContain('未执行')
    expect(f.selection.values()).toEqual([])
    if (mode !== 'deleted') expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
    act(() => {
      f.doc.readOnly = false
      if (mode === 'deleted') f.doc.undo.undo()
      else f.doc.mutable(f.id)!.set('results', f.results)
      f.doc.flush()
    })
    await f.user.click(
      screen.getByRole('button', { name: mode === 'deleted' ? '定位来源' : '采用此候选' }),
    )
    if (mode === 'deleted') expect(f.selection.values()).toEqual([f.id])
    else expect(f.doc.get(f.id)!.adopted).toBe(f.results[1]!.id)
  },
)
it.each(['rename', 'clear-name'] as const)(
  '实时 %s 更新标题而保留缩放；删除来源后记住最后名称',
  async (mode) => {
    const f = setup()
    await f.user.click(screen.getByRole('button', { name: '放大图片' }))
    const name = mode === 'rename' ? '新名称' : '图片生成'
    act(() => {
      f.doc.mutable(f.id)!.set('name', mode === 'rename' ? name : '')
      f.doc.flush()
    })
    const actual = screen.getByRole('heading').textContent!
    expect(actual).toBe(mode === 'rename' ? name : '生成图片')
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(`查看「${actual}」`)
    expect(screen.getByRole('button', { name: '重置图片视图' }).textContent).toBe('125%')
    act(() => {
      deleteElements(f.doc, [f.id])
      f.doc.flush()
    })
    expect(screen.getByRole('heading').textContent).toBe(actual)
    expect(screen.getByRole('status').textContent).toContain('来源节点已删除')
  },
)
it.each(['removed', 'type', 'self', 'replace', 'stable'] as const)(
  '实时对比 %s 不串候选或误采用',
  async (mode) => {
    const f = setup()
    const index = mode === 'stable' ? 2 : 1
    await f.user.selectOptions(
      screen.getByRole('combobox', { name: '对比候选' }),
      f.results[index]!.id,
    )
    if (mode === 'removed') f.update(f.results.filter((_, i) => i !== 1))
    if (mode === 'type')
      f.update(
        f.results.map((r, i) => (i === 1 ? { ...r, value: { type: 'text', text: '变更' } } : r)),
      )
    if (mode === 'self') await f.user.click(screen.getByRole('button', { name: '预览下一个候选' }))
    if (mode === 'replace') {
      f.update(f.results.map((r, i) => (i === 1 ? { ...r, value: f.results[3]!.value } : r)))
      expect(screen.getByRole('img', { name: '候选 B' }).getAttribute('src')).toContain(
        `${f.id}-asset-3`,
      )
    } else if (mode === 'stable') {
      await f.user.selectOptions(screen.getByRole('combobox', { name: '对比方式' }), 'slider')
      fireEvent.change(screen.getByRole('slider'), { target: { value: '70' } })
      for (const key of ['ArrowRight', 'ArrowLeft']) fireEvent.keyDown(f.group(), { key })
      expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('70')
      expect(screen.getByRole('img', { name: '候选 B' }).getAttribute('src')).toContain(
        `${f.id}-asset-2`,
      )
    } else {
      expect(screen.queryByRole('img', { name: '候选 B' })).toBeNull()
      expect((screen.getByRole('combobox', { name: '对比候选' }) as HTMLSelectElement).value).toBe(
        '',
      )
      expect(screen.getByRole('status').textContent).toContain('已退出对比')
    }
    expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
  },
)
it('独立图片与唯一候选的方向键保留视图，移除后可找回剩余候选', async () => {
  const f = setup('image', 2)
  f.update([f.results[1]!])
  await f.user.click(screen.getByRole('button', { name: '预览下一个候选' }))
  await f.user.click(screen.getByRole('button', { name: '放大图片' }))
  fireEvent.keyDown(f.group(), { key: 'ArrowRight' })
  expect(screen.getByRole('button', { name: '重置图片视图' }).textContent).toBe('125%')
  expect(
    (screen.getByRole('button', { name: '预览下一个候选' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  act(() => useCanvas.setState({ viewer: { kind: 'image', assetId: 'single', name: '独立图片' } }))
  await f.user.click(screen.getByRole('button', { name: '放大图片' }))
  for (const key of ['ArrowRight', 'ArrowLeft', 'Enter']) fireEvent.keyDown(f.group(), { key })
  expect(screen.getByRole('button', { name: '重置图片视图' }).textContent).toBe('125%')
  expect(screen.queryByRole('alert')).toBeNull()
})
it('图片失败两侧独立重试、忽略旧事件且恢复键盘操作焦点', async () => {
  const f = setup()
  await f.user.selectOptions(screen.getByRole('combobox', { name: '对比候选' }), f.results[1]!.id)
  const a = screen.getByRole('img', { name: '候选 A' })
  const b = screen.getByRole('img', { name: '候选 B' })
  fireEvent.error(a)
  fireEvent.error(b)
  expect(screen.getAllByRole('alert')).toHaveLength(2)
  await f.user.click(screen.getByRole('button', { name: '重新加载候选 A' }))
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(document.activeElement).toBe(f.group())
  fireEvent.error(a)
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  await f.user.click(screen.getByRole('button', { name: '重新加载候选 B' }))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
})
it.each(['audio', 'video'] as const)(
  '%s 本地预览使用本地 URL，重试恢复焦点，类型切换与关闭释放旧播放器',
  async (kind) => {
    const f = setup(kind, 1)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load')
    act(() =>
      useCanvas.setState({
        localAssetUrls: new Map([[`${f.id}-asset-0`, 'blob:checkpoint-media']]),
      }),
    )
    const media = document.querySelector(kind)!
    expect(media.getAttribute('src')).toBe('blob:checkpoint-media')
    expect(media.getAttribute('poster')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(media.getAttribute('aria-label')).toBe(
      `审片素材 ${kind === 'audio' ? '音频' : '视频'}播放器`,
    )
    fireEvent.error(media)
    await f.user.click(screen.getByRole('button', { name: '重新加载媒体' }))
    expect(document.activeElement).toBe(f.group())
    expect(document.querySelector(kind)!.getAttribute('src')).toBe('blob:checkpoint-media')
    const old = document.querySelector(kind)!
    f.update(
      f.results.map((r) => ({
        ...r,
        value: { type: kind === 'audio' ? 'video' : 'audio', assetId: `${f.id}-asset-0` },
      })),
    )
    expect(old.getAttribute('src')).toBeNull()
    const next = document.querySelector(kind === 'audio' ? 'video' : 'audio')!
    expect(next.getAttribute('src')).toBe('blob:checkpoint-media')
    await f.user.click(screen.getByRole('button', { name: '关闭' }))
    expect(next.getAttribute('src')).toBeNull()
    expect(pause).toHaveBeenCalled()
    expect(load).toHaveBeenCalled()
  },
)
it('拖动只接受当前指针；取消、失焦和重置后不再移动', () => {
  const f = setup()
  const surface = f.image().parentElement!
  let captured: number | undefined
  surface.setPointerCapture = (id) => {
    captured = id
  }
  surface.hasPointerCapture = (id) => id === captured
  surface.releasePointerCapture = () => {
    captured = undefined
  }
  const begin = () => {
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 30, clientY: 10 })
  }
  begin()
  const before = surface.style.transform
  fireEvent.pointerMove(surface, { pointerId: 2, clientX: 100, clientY: 100 })
  fireEvent.pointerCancel(surface, { pointerId: 2 })
  expect(surface.style.transform).toBe(before)
  fireEvent.pointerCancel(surface, { pointerId: 1 })
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100, clientY: 100 })
  expect(surface.style.transform).toBe(before)
  begin()
  const moved = surface.style.transform
  fireEvent(window, new Event('blur'))
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 200, clientY: 100 })
  expect(surface.style.transform).toBe(moved)
  begin()
  fireEvent.click(screen.getByRole('button', { name: '重置图片视图' }))
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 200, clientY: 100 })
  expect(surface.style.transform).toBe('translate(0px, 0px) scale(1)')
})

it('音频波形失败不阻断播放器，媒体有独立可恢复错误', async () => {
  const f = setup('audio')
  fireEvent.error(document.querySelector('img')!)
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('audio')!.getAttribute('src')).toBe(`/api/assets/${f.id}-asset-0`)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.error(document.querySelector('audio')!)
  expect(screen.getByRole('alert').textContent).toBe('音频加载失败')
  await f.user.click(screen.getByRole('button', { name: '重新加载媒体' }))
  expect(document.querySelector('audio')).not.toBeNull()
  expect(f.doc.get(f.id)!.adopted).toBe(f.results[0]!.id)
})
it('全部候选移除后 Enter 不采用或定位，也不混入副输出；恢复同端口后继续浏览', async () => {
  const f = setup()
  const original = f.doc.get(f.id)!.adopted
  f.update([
    { ...f.results[0]!, id: 'metadata', port: 'metadata', value: { type: 'text', text: '副输出' } },
  ])
  expect(screen.getByText('候选已移除或素材不可用')).toBeTruthy()
  fireEvent.keyDown(f.group(), { key: 'Enter' })
  expect(f.doc.get(f.id)!.adopted).toBe(original)
  expect(screen.queryByText('副输出')).toBeNull()
  f.update([f.results[1]!])
  await f.user.click(screen.getByRole('button', { name: '预览下一个候选' }))
  expect(f.image().getAttribute('src')).toBe(`/api/assets/${f.id}-asset-1`)
})

const reviewDocs: PleinDoc[] = []
afterEach(() => reviewDocs.splice(0).forEach((doc) => doc.destroy()))
function setupReview() {
  const doc = openDoc()
  reviewDocs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    name: '候选审核',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  addResults(
    doc,
    id,
    ['first', 'second'].map((id, at) => ({
      id,
      at,
      runId: 'run',
      port: 'images',
      value: { type: 'image' as const, assetId: id },
    })),
    { adopt: true },
  )
  const original = doc.get(id)!.adopted
  useCanvas.setState({
    engine: { doc } as Engine,
    canvasId: 'c',
    viewer: { kind: 'result', name: '候选审核', nodeId: id, resultId: original! },
  })
  const rendered = renderApp(<Viewer />)
  return { ...rendered, doc, id, original }
}
it('浏览及对比不采用，明确采用更新文档且可撤销', async () => {
  const f = setupReview()
  await f.user.click(screen.getByRole('button', { name: '预览下一个候选' }))
  expect(f.doc.get(f.id)?.adopted).toBe(f.original)
  await f.user.selectOptions(screen.getByRole('combobox', { name: '对比候选' }), f.original!)
  expect(screen.getByRole('img', { name: '候选 A' })).toBeTruthy()
  expect(screen.getByRole('img', { name: '候选 B' })).toBeTruthy()
  await f.user.selectOptions(screen.getByRole('combobox', { name: '对比方式' }), 'slider')
  fireEvent.change(screen.getByRole('slider', { name: '图片对比滑杆' }), {
    target: { value: '70' },
  })
  expect(f.doc.get(f.id)?.adopted).toBe(f.original)
  await f.user.click(screen.getByRole('button', { name: '采用此候选' }))
  act(() => f.doc.flush())
  expect(f.doc.get(f.id)?.adopted).not.toBe(f.original)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '已采用' }).disabled).toBe(true)
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.doc.get(f.id)?.adopted).toBe(f.original)
})
it('按钮 Enter 执行本意，预览区 Enter 才采用，组字 Enter 不采用', async () => {
  const f = setupReview()
  screen.getByRole('button', { name: '预览下一个候选' }).focus()
  await f.user.keyboard('{Enter}')
  expect(f.doc.get(f.id)?.adopted).toBe(f.original)
  const group = screen.getByRole('group', { name: '候选审片操作' })
  fireEvent.keyDown(group, { key: 'Enter', isComposing: true })
  expect(f.doc.get(f.id)?.adopted).toBe(f.original)
  group.focus()
  await f.user.keyboard('{Enter}')
  expect(f.doc.get(f.id)?.adopted).not.toBe(f.original)
  screen.getByRole('button', { name: '关闭' }).focus()
  await f.user.keyboard('{Enter}')
  expect(useCanvas.getState().viewer).toBeNull()
})
