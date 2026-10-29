// @vitest-environment happy-dom
import {
  addResults,
  createElement,
  creativeReviewTarget,
  getCreativeReview,
  recordCreativeReview,
  type CreativeReview,
  type CreativeReviewTarget,
} from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { afterEach, expect, it } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import {
  CONTINUITY_NOTE_LIMIT,
  ContinuityNoteForm,
  continuityNoteLines,
  markContinuityChanges,
  resolveContinuity,
  type ContinuityNoteView,
} from './ContinuityNoteForm'
import { hasContinuityOpinion } from './reviewTags'

const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

function setup() {
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(
    doc,
    node({
      nodeType: 'plein/video',
      name: '衔接候选',
      params: {},
      ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
    }),
  )
  addResults(doc, id, [
    {
      id: 'candidate-a',
      runId: 'run-a',
      port: 'video',
      value: { type: 'video', assetId: 'a'.repeat(64) },
      at: 1,
    },
  ])
  const element = doc.get(id)!
  const target = creativeReviewTarget(element)!
  return { doc, id, element, target }
}

const reviewOf = (f: ReturnType<typeof setup>): CreativeReview | undefined =>
  getCreativeReview(f.doc.get(f.id), f.target)

function renderNoteForm(
  f: ReturnType<typeof setup>,
  view: Partial<ContinuityNoteView> = {},
  extra: Partial<Parameters<typeof ContinuityNoteForm>[0]> = {},
) {
  const model: ContinuityNoteView = {
    target: f.target,
    targetReview: reviewOf(f),
    viewingAdopted: true,
    ...view,
  }
  return renderApp(
    <ContinuityNoteForm
      doc={f.doc}
      node={f.doc.get(f.id)}
      view={model}
      writable={() => !f.doc.readOnly}
      {...extra}
    />,
  )
}

it('标记需修改取标签并集并追加一行备注，不覆盖已有内容', () => {
  const target: CreativeReviewTarget = { kind: 'video', assetId: 'a'.repeat(64) }
  expect(
    markContinuityChanges(
      {
        target,
        status: 'changes',
        tags: ['composition', 'continuity-costume'],
        note: '已有备注',
        at: 1,
      },
      ['continuity-lighting'],
      '光线突变',
    ),
  ).toEqual({
    status: 'changes',
    tags: ['composition', 'continuity-costume', 'continuity', 'continuity-lighting'],
    note: '已有备注\n衔接：光线突变',
  })
  expect(markContinuityChanges(undefined, [], '  ')).toEqual({
    status: 'changes',
    tags: ['continuity'],
    note: '',
  })
})

it('已解决只移除衔接标签，没有其他问题标签才交还整体审阅，绝不自动判可用', () => {
  const target: CreativeReviewTarget = { kind: 'video', assetId: 'a'.repeat(64) }
  expect(
    resolveContinuity({
      target,
      status: 'changes',
      tags: ['composition', 'continuity-costume'],
      note: '备注保留',
      at: 1,
    }),
  ).toEqual({ status: 'changes', tags: ['composition'], note: '备注保留' })
  expect(
    resolveContinuity({ target, status: 'changes', tags: ['continuity'], note: '', at: 1 }),
  ).toEqual({ status: 'pending', tags: [], note: '' })
  expect(
    resolveContinuity({ target, status: 'usable', tags: ['continuity'], note: '', at: 1 }).status,
  ).toBe('usable')
  expect(resolveContinuity(undefined)).toEqual({ status: 'pending', tags: [], note: '' })
  expect(continuityNoteLines('第一行\n衔接：光向反了\n再一句')).toEqual(['衔接：光向反了'])
})

it('只有需修改的验收还挂着衔接标签才算未解决', () => {
  const target: CreativeReviewTarget = { kind: 'video', assetId: 'a'.repeat(64) }
  expect(
    hasContinuityOpinion({
      target,
      status: 'changes',
      tags: ['continuity-costume'],
      note: '',
      at: 1,
    }),
  ).toBe(true)
  expect(
    hasContinuityOpinion({
      target,
      status: 'usable',
      tags: ['continuity-costume'],
      note: '',
      at: 1,
    }),
  ).toBe(false)
  expect(
    hasContinuityOpinion({ target, status: 'changes', tags: ['composition'], note: '', at: 1 }),
  ).toBe(false)
})

it('标记需修改写入采用候选：changes、衔接标签与追加备注', async () => {
  const f = setup()
  const { user } = renderNoteForm(f)
  await user.click(screen.getByRole('checkbox', { name: '服装' }))
  await user.type(screen.getByRole('textbox', { name: '衔接意见备注' }), '上衣颜色变了')
  await user.click(screen.getByRole('button', { name: '标记需修改' }))
  expect(f.doc.get(f.id)?.reviews).toEqual([
    expect.objectContaining({
      status: 'changes',
      tags: ['continuity', 'continuity-costume'],
      note: '衔接：上衣颜色变了',
      target: f.target,
    }),
  ])
})

it('保存前重读最新意见，并集与追加不覆盖协作者的修改', async () => {
  const f = setup()
  const { user } = renderNoteForm(f, { targetReview: undefined })
  // 渲染之后协作者写入了意见
  recordCreativeReview(f.doc, f.id, {
    target: f.target,
    status: 'changes',
    tags: ['composition'],
    note: '已有备注',
  })
  await user.click(screen.getByRole('checkbox', { name: '服装' }))
  await user.type(screen.getByRole('textbox', { name: '衔接意见备注' }), '光向反了')
  await user.click(screen.getByRole('button', { name: '标记需修改' }))
  expect(f.doc.get(f.id)?.reviews).toEqual([
    expect.objectContaining({
      status: 'changes',
      tags: ['composition', 'continuity', 'continuity-costume'],
      note: '已有备注\n衔接：光向反了',
    }),
  ])
})

it('勾选从空开始，已有意见只在摘要展示', () => {
  const f = setup()
  recordCreativeReview(f.doc, f.id, {
    target: f.target,
    status: 'changes',
    tags: ['continuity', 'continuity-costume'],
    note: '衔接：上衣颜色变了',
  })
  renderNoteForm(f)
  expect((screen.getByRole('checkbox', { name: '服装' }) as HTMLInputElement).checked).toBe(false)
  const region = screen.getByLabelText('衔接意见')
  expect(region.textContent).toContain('衔接需修改：服装')
  expect(region.textContent).toContain('衔接：上衣颜色变了')
})

it('备注追加超过上限时提示且不保存，不静默截断', async () => {
  const f = setup()
  recordCreativeReview(f.doc, f.id, {
    target: f.target,
    status: 'changes',
    tags: ['continuity'],
    note: 'x'.repeat(CONTINUITY_NOTE_LIMIT - 2),
  })
  const { user } = renderNoteForm(f)
  await user.click(screen.getByRole('checkbox', { name: '服装' }))
  await user.type(screen.getByRole('textbox', { name: '衔接意见备注' }), '光向反了')
  await user.click(screen.getByRole('button', { name: '标记需修改' }))
  expect(screen.getByRole('alert').textContent).toContain('备注已接近上限')
  expect(getCreativeReview(f.doc.get(f.id), f.target)?.note).toBe(
    'x'.repeat(CONTINUITY_NOTE_LIMIT - 2),
  )
})

it('没有待解决的衔接意见时「已解决」不可用', () => {
  const f = setup()
  const { unmount } = renderNoteForm(f)
  expect(
    (screen.getByRole('button', { name: '衔接问题已解决' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  unmount()
  recordCreativeReview(f.doc, f.id, {
    target: f.target,
    status: 'changes',
    tags: ['continuity', 'continuity-costume'],
    note: '衔接：上衣颜色变了',
  })
  // 已有待解决的衔接意见后按钮可用（父组件按 review.at 重新挂载）
  renderNoteForm(f)
  expect(
    (screen.getByRole('button', { name: '衔接问题已解决' }) as HTMLButtonElement).disabled,
  ).toBe(false)
})

it('查看非采用候选时只读：展示其自身意见并说明记录位置', () => {
  const f = setup()
  const viewed: CreativeReviewTarget = {
    kind: 'video',
    assetId: 'b'.repeat(64),
    resultId: 'candidate-b',
  }
  renderNoteForm(f, {
    viewingAdopted: false,
    viewedTarget: viewed,
    viewedReview: {
      target: viewed,
      status: 'changes',
      tags: ['continuity', 'continuity-lighting'],
      note: '衔接：光向反了',
      at: 1,
    },
    adoptedOpinion: '已采用候选有衔接意见：服装',
  })
  const region = screen.getByLabelText('衔接意见')
  expect(region.textContent).toContain('衔接需修改：光线')
  expect(region.textContent).toContain('衔接：光向反了')
  expect(region.textContent).toContain('衔接意见记在已采用的候选上')
  expect(region.textContent).toContain('已采用候选有衔接意见：服装')
  // happy-dom 里 fieldset 的禁用不反映到 input.disabled 属性，直接断言 fieldset
  expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '标记需修改' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
})

it('查看的候选自身没有衔接意见时明确说明', () => {
  const f = setup()
  renderNoteForm(f, {
    viewingAdopted: false,
    viewedTarget: { kind: 'video', assetId: 'b'.repeat(64), resultId: 'candidate-b' },
    viewedReview: undefined,
  })
  const region = screen.getByLabelText('衔接意见')
  expect(region.textContent).toContain('此候选没有衔接意见')
  expect((screen.getByRole('button', { name: '标记需修改' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
})

it('还没有采用项时提示先采用，没有候选时说明为空', () => {
  const f = setup()
  const { unmount } = renderNoteForm(f, { needAdopt: true })
  expect(screen.getByText('先采用一个候选再记衔接意见')).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: '服装' })).toBeNull()
  unmount()

  renderNoteForm(f, { target: undefined, targetReview: undefined }, { node: undefined })
  expect(screen.getByText('本镜还没有候选')).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: '服装' })).toBeNull()
})

it('只读时点击不写入文档', async () => {
  const f = setup()
  f.doc.readOnly = true
  const { user } = renderNoteForm(f)
  expect((screen.getByRole('button', { name: '标记需修改' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  // happy-dom 里 fieldset 的禁用不反映到 input.disabled 属性，直接断言 fieldset
  expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '标记需修改' }))
  expect(f.doc.get(f.id)?.reviews ?? []).toEqual([])
})
