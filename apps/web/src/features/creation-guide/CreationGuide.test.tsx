// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  adoptResult,
  connect,
  createElement,
  deleteElements,
  selectProductionTarget,
  setParams,
  updateElement,
  type PleinDoc,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { LOCAL_PRINCIPAL } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { act, fireEvent, renderApp, screen, within } from '../../testing/render'
import { CreationGuide } from './CreationGuide'
import { writeGuidePreferences } from './preferences'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function fixture(boards = 1) {
  const doc = openDoc()
  docs.push(doc)
  const shots = [1, 2].map((no) => Shot.parse({ id: `s${no}`, no, description: `画面${no}` }))
  const ids = Array.from({ length: boards }, (_, i) =>
    createElement(doc, {
      kind: 'node',
      nodeType: 'plein/storyboard',
      name: `分镜${i + 1}`,
      params: { shots },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    }),
  )
  const engine = { doc, selection: { set: vi.fn() }, zoomToFit: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'c1', sync: 'connected' })
  useSession.setState({
    info: { principal: LOCAL_PRINCIPAL, authRequired: false, needsSetup: false },
  })
  const host = document.createElement('div')
  host.id = 'plein-creation-guide-entry'
  document.body.append(host)
  const onOpenText = vi.fn(),
    onWidthChange = vi.fn()
  const ui = (canvasId = 'c1', presentation: 'floating' | 'modal' = 'floating') => (
    <CreationGuide
      canvasId={canvasId}
      presentation={presentation}
      onOpenText={onOpenText}
      onWidthChange={onWidthChange}
    />
  )
  const rendered = renderApp(ui())
  return { doc, ids, shots, engine, ...rendered, ui, onWidthChange, host }
}
const step = (id: string) => document.querySelector<HTMLElement>(`[data-guide-step="${id}"]`)!
const clickStep = (id: string) => fireEvent.click(within(step(id)).getByRole('button'))
function change(f: ReturnType<typeof fixture>, fn: () => void) {
  act(() => {
    fn()
    f.doc.flush()
  })
}
function media(f: ReturnType<typeof fixture>, role: 'image' | 'video', shot = 's1') {
  const id = createElement(f.doc, {
    kind: 'node',
    nodeType: `plein/${role}`,
    name: role,
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    params: { source: { storyboard: f.ids[0], shot, role } },
    ports: { inputs: [], outputs: [{ id: role, type: role, label: role }] },
  })
  addResults(
    f.doc,
    id,
    [
      {
        id: `${id}-r1`,
        runId: 'r1',
        at: 1,
        port: role,
        value: { type: role, assetId: 'a'.repeat(64) },
      },
    ],
    { adopt: true },
  )
  return id
}
function sequence(f: ReturnType<typeof fixture>, video: string, name = '成片') {
  const id = createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/sequence',
    name,
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    params: {},
    ports: { inputs: [{ id: 'clips', type: 'video', label: '镜头', multiple: true }], outputs: [] },
  })
  expect(connect(f.doc, [video, 'video'], [id, 'clips'])).toBeTruthy()
  return id
}

it('六步只定位，收起重新挂载沿用本画布偏好，切换画布重新读取偏好', () => {
  const f = fixture()
  expect(document.querySelectorAll('[data-guide-step]')).toHaveLength(6)
  clickStep('storyboard')
  expect(useCanvas.getState().storyboard).toBe(f.ids[0])
  expect(f.engine.selection.set).toHaveBeenCalledWith([f.ids[0]])
  const before = [...f.doc.elements()]
  fireEvent.click(
    within(screen.getByTestId('creation-guide')).getByRole('button', { name: '收起创作引导' }),
  )
  expect(screen.queryByTestId('creation-guide')).toBeNull()
  expect(f.onWidthChange).toHaveBeenLastCalledWith(0)
  writeGuidePreferences('c2', { collapsed: false })
  act(() => {
    useCanvas.setState({ canvasId: 'c2' })
    f.rerender(f.ui('c2'))
  })
  expect(screen.getByTestId('creation-guide')).toBeTruthy()
  expect(f.onWidthChange).toHaveBeenLastCalledWith(360)
  act(() => {
    useCanvas.setState({ canvasId: 'c1' })
    f.rerender(f.ui())
  })
  expect(screen.queryByTestId('creation-guide')).toBeNull()
  expect([...f.doc.elements()]).toEqual(before)
  f.host.remove()
})

it('多分镜显式选择，删除后不改选剩余分镜，撤销后保持原选择', async () => {
  const f = fixture(2)
  expect(document.querySelectorAll('[data-guide-step]')).toHaveLength(0)
  await f.user.click(screen.getByRole('combobox', { name: '创作引导分镜' }))
  await f.user.click(screen.getByRole('option', { name: '分镜2' }))
  clickStep('storyboard')
  expect(f.engine.selection.set).toHaveBeenLastCalledWith([f.ids[1]])
  change(f, () => {
    f.doc.undo.stopCapturing()
    deleteElements(f.doc, [f.ids[1]!])
  })
  expect(screen.getByText(/原分镜选择已失效/)).toBeTruthy()
  change(f, () => f.doc.undo.undo())
  clickStep('storyboard')
  expect(f.engine.selection.set).toHaveBeenLastCalledWith([f.ids[1]])
  f.host.remove()
})

it.each(['plan', 'type'] as const)('同帧 %s 变化拒绝旧回调，恢复后可以操作', (mode) => {
  const f = fixture()
  const button =
    mode === 'plan'
      ? screen.getByRole('button', { name: '我已人工核对这份分镜' })
      : within(step('storyboard')).getByRole('button')
  act(() => {
    if (mode === 'plan')
      setParams(f.doc, f.ids[0]!, { shots: f.shots.map((s) => ({ ...s, description: '变更' })) })
    else updateElement(f.doc, f.ids[0]!, { nodeType: 'plein/image' })
    fireEvent.click(button)
  })
  expect(f.doc.get(f.ids[0]!)?.production?.confirmations ?? []).toEqual([])
  expect(f.engine.selection.set).not.toHaveBeenCalled()
  if (mode === 'plan') expect(screen.getByRole('alert').textContent).toContain('分镜计划已变化')
  change(f, () => updateElement(f.doc, f.ids[0]!, { nodeType: 'plein/storyboard' }))
  fireEvent.click(screen.getByRole('button', { name: '我已人工核对这份分镜' }))
  change(f, () => {})
  expect(step('storyboard').dataset.guideState).toBe('done')
  expect(f.doc.get(f.ids[0]!)?.production?.confirmations[0]?.actor).toEqual({
    userId: LOCAL_PRINCIPAL.id,
    source: 'ui',
  })
  f.host.remove()
})

it('唯一成片变为多个和候选改变时拒绝旧定位，重新选择后使用新身份', async () => {
  const f = fixture()
  let video = '',
    image = '',
    first = ''
  change(f, () => {
    image = media(f, 'image')
    video = media(f, 'video')
    first = sequence(f, video)
  })
  const oldDelivery = within(step('delivery')).getByRole('button')
  let second = ''
  act(() => {
    second = sequence(f, video, '第二版')
    fireEvent.click(oldDelivery)
  })
  expect(f.engine.selection.set).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('定位目标已变化')
  change(f, () => {})
  await f.user.click(screen.getByRole('combobox', { name: '创作引导交付序列' }))
  await f.user.click(screen.getByRole('option', { name: '第二版' }))
  change(f, () => {})
  clickStep('delivery')
  expect(f.engine.selection.set).toHaveBeenLastCalledWith([second])
  expect(second).not.toBe(first)
  const oldReview = within(step('review')).getByRole('button')
  act(() => {
    addResults(f.doc, image, [
      {
        id: 'new-image',
        runId: 'new-run',
        at: 2,
        port: 'image',
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    adoptResult(f.doc, image, 'new-image')
    fireEvent.click(oldReview)
  })
  expect(screen.getByRole('alert').textContent).toContain('定位目标已变化')
  change(f, () => {})
  clickStep('review')
  expect(useCanvas.getState().viewer).toMatchObject({ nodeId: image, resultId: 'new-image' })
  f.host.remove()
})

it('代表镜头删除后保留失效身份、禁止审片；撤销恢复且只读禁写', () => {
  const f = fixture()
  change(f, () => {
    media(f, 'image', 's2')
    media(f, 'video', 's2')
    selectProductionTarget(f.doc, f.ids[0]!, { trialShotId: 's2' })
  })
  expect(step('trial').dataset.guideState).toBe('done')
  change(f, () => {
    f.doc.undo.stopCapturing()
    setParams(f.doc, f.ids[0]!, { shots: [f.shots[0]] })
  })
  expect(step('trial').dataset.guideState).toBe('attention')
  expect(within(step('review')).getByRole<HTMLButtonElement>('button').disabled).toBe(true)
  expect(f.doc.get(f.ids[0]!)?.production?.selection?.trialShotId).toBe('s2')
  change(f, () => f.doc.undo.undo())
  expect(step('trial').dataset.guideState).toBe('done')
  change(f, () => {
    f.doc.readOnly = true
    f.doc.mutable(f.ids[0]!)!.set('rotation', 1)
  })
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: '我已人工核对这份分镜' }).disabled,
  ).toBe(true)
  expect(
    screen.getByRole<HTMLButtonElement>('combobox', { name: '创作引导试做镜头' }).disabled,
  ).toBe(true)
  f.host.remove()
})

it('当前步骤只有一个主操作，试做子步骤按固定顺序定位并拒绝旧目标', () => {
  const f = fixture()
  expect(document.querySelectorAll('[data-guide-step] .ui-btn-primary')).toHaveLength(1)
  const trial = step('trial')
  expect(
    [...trial.querySelectorAll<HTMLElement>('[data-guide-substep]')].map(
      (el) => el.dataset.guideSubstep,
    ),
  ).toEqual(['shot', 'input', 'generate', 'review', 'sample'])
  const generate = within(trial).getByRole('button', { name: /^生成并采用候选 / })
  fireEvent.click(generate)
  expect(useCanvas.getState().shotWorkbench).toEqual({ boardId: f.ids[0], shotId: 's1' })
  fireEvent.click(within(trial).getByRole('button', { name: /选代表镜头/ }))
  expect(document.activeElement?.id).toBe('c1-guide-shot')
  act(() => {
    selectProductionTarget(f.doc, f.ids[0]!, { trialShotId: 's2' })
    fireEvent.click(generate)
  })
  expect(screen.getByRole('alert').textContent).toContain('定位目标已变化')
  expect(useCanvas.getState().shotWorkbench).toEqual({ boardId: f.ids[0], shotId: 's1' })
  f.host.remove()
})

it('制作目标追加独立版本、撤销保留旧版；同帧只读不保存草稿', async () => {
  const f = fixture()
  await f.user.click(screen.getByText('编辑制作目标', { exact: true }))
  await f.user.click(screen.getByRole('button', { name: '填写或修订制作目标' }))
  const field = () => screen.getByRole('textbox', { name: '文字创作要求' })
  fireEvent.change(field(), { target: { value: '交接动作清楚' } })
  fireEvent.click(screen.getByRole('button', { name: '保存目标新版本' }))
  change(f, () => {})
  const first = f.doc.get(f.ids[0]!)?.production?.goals?.[0]
  expect(first?.content.requirements).toBe('交接动作清楚')
  fireEvent.click(screen.getByRole('button', { name: '填写或修订制作目标' }))
  fireEvent.change(field(), { target: { value: '保留风声' } })
  fireEvent.click(screen.getByRole('button', { name: '保存目标新版本' }))
  change(f, () => {})
  expect(f.doc.get(f.ids[0]!)?.production?.goals).toHaveLength(2)
  change(f, () => f.doc.undo.undo())
  expect(f.doc.get(f.ids[0]!)?.production?.goals).toEqual([first])
  change(f, () => f.doc.undo.redo())
  fireEvent.click(screen.getByRole('button', { name: '填写或修订制作目标' }))
  fireEvent.change(field(), { target: { value: '不可保存' } })
  f.doc.readOnly = true
  fireEvent.click(screen.getByRole('button', { name: '保存目标新版本' }))
  expect(screen.getByRole('alert').textContent).toContain('当前只读')
  expect(f.doc.get(f.ids[0]!)?.production?.goals).toHaveLength(2)
  expect(screen.getByText(/文字要求需人工审看/)).toBeTruthy()
  f.host.remove()
})

it('弹窗模式收起后保持选择，切到浮动模式释放弹窗并恢复预留宽度', async () => {
  const f = fixture()
  f.rerender(f.ui('c1', 'modal'))
  expect(screen.queryByTestId('creation-guide')).toBeNull()
  await f.user.click(screen.getByRole('button', { name: '展开创作引导' }))
  const dialog = screen.getByRole('dialog', { name: '创作下一步' })
  await f.user.click(within(dialog).getByRole('combobox', { name: '创作引导试做镜头' }))
  await f.user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByRole('dialog', { name: '创作下一步' })).toBe(dialog)
  await f.user.click(within(dialog).getByRole('combobox', { name: '创作引导试做镜头' }))
  await f.user.click(screen.getByRole('option', { name: '镜头 2 · 画面2' }))
  change(f, () => {})
  f.rerender(f.ui())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.doc.get(f.ids[0]!)?.production?.selection?.trialShotId).toBe('s2')
  expect(f.onWidthChange).toHaveBeenLastCalledWith(360)
  f.host.remove()
})

it('制作决策追加修订后旧记录保留，撤销重做不改写原记录', async () => {
  const f = fixture()
  await f.user.click(screen.getByText('制作决策（0）'))
  fireEvent.change(screen.getByRole('textbox', { name: '本次选择' }), {
    target: { value: '黑白纪实' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: '修订理由' }), {
    target: { value: '先试辨识度' },
  })
  await f.user.click(screen.getByRole('button', { name: '保存为新修订' }))
  change(f, () => {})
  const first = f.doc.get(f.ids[0]!)?.production?.decisions[0]
  fireEvent.change(screen.getByRole('textbox', { name: '本次选择' }), {
    target: { value: '暖色纪实' },
  })
  await f.user.click(screen.getByRole('button', { name: '保存为新修订' }))
  change(f, () => {})
  expect(f.doc.get(f.ids[0]!)?.production?.decisions[0]).toEqual(first)
  expect(screen.getByRole('list', { name: '制作决策历史' }).textContent).toContain(
    '暖色纪实 · 当前选择',
  )
  change(f, () => f.doc.undo.undo())
  expect(f.doc.get(f.ids[0]!)?.production?.decisions).toEqual([first])
  change(f, () => f.doc.undo.redo())
  expect(f.doc.get(f.ids[0]!)?.production?.decisions).toHaveLength(2)
  f.host.remove()
})

it('只读时已有样片可打开，无样片时说明原因且不创建', () => {
  const f = fixture()
  change(f, () => {
    f.doc.readOnly = true
    f.doc.mutable(f.ids[0]!)!.set('name', '只读分镜')
  })
  fireEvent.click(screen.getByRole('button', { name: /做样片/ }))
  expect(screen.getByRole('alert').textContent).toContain('不能创建新样片')
  expect([...f.doc.elements()]).toHaveLength(1)
  f.doc.readOnly = false
  let animatic = ''
  change(f, () => {
    animatic = createElement(f.doc, {
      kind: 'node',
      nodeType: 'plein/animatic',
      params: { boardId: f.ids[0] },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    f.doc.readOnly = true
  })
  fireEvent.click(screen.getByRole('button', { name: /做样片/ }))
  expect(useCanvas.getState().sequence).toBe(animatic)
  expect([...f.doc.elements()]).toHaveLength(2)
  f.host.remove()
})
