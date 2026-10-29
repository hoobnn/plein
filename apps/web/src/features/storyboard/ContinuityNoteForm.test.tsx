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
  ContinuityNoteForm,
  continuityNoteLines,
  hasContinuityOpinion,
  markContinuityChanges,
  resolveContinuity,
} from './ContinuityNoteForm'

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
  extra: Partial<Parameters<typeof ContinuityNoteForm>[0]> = {},
) {
  return renderApp(
    <ContinuityNoteForm
      doc={f.doc}
      node={f.element}
      target={f.target}
      review={reviewOf(f)}
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
  expect(
    hasContinuityOpinion({ target, status: 'changes', tags: ['other'], note: '', at: 1 }),
  ).toBe(false)
  expect(continuityNoteLines('第一行\n衔接：光向反了\n再一句')).toEqual(['衔接：光向反了'])
})

it('标记需修改写入当前候选：changes、衔接标签与追加备注', async () => {
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

it('已有细分标签回显勾选，已解决后交还整体审阅且备注保留', async () => {
  const f = setup()
  recordCreativeReview(f.doc, f.id, {
    target: f.target,
    status: 'changes',
    tags: ['continuity', 'continuity-costume'],
    note: '衔接：上衣颜色变了',
  })
  const { user } = renderNoteForm(f)
  expect((screen.getByRole('checkbox', { name: '服装' }) as HTMLInputElement).checked).toBe(true)
  await user.click(screen.getByRole('button', { name: '衔接问题已解决' }))
  expect(f.doc.get(f.id)?.reviews).toEqual([
    expect.objectContaining({ status: 'pending', tags: [], note: '衔接：上衣颜色变了' }),
  ])
})
it('摘要只列细分标签与衔接备注行，之前的候选有意见时提示重审', () => {
  const f = setup()
  recordCreativeReview(f.doc, f.id, {
    target: f.target,
    status: 'changes',
    tags: ['continuity', 'continuity-lighting'],
    note: '前一句\n衔接：光向反了\n后面一句',
  })
  const { unmount } = renderNoteForm(f)
  const region = screen.getByLabelText('衔接意见')
  expect(region.textContent).toContain('衔接需修改：光线')
  expect(region.textContent).toContain('衔接：光向反了')
  expect(region.textContent).not.toContain('前一句')
  unmount()

  const fresh = setup()
  renderNoteForm(fresh, { priorOpinion: true })
  expect(screen.getByText('之前的候选有衔接意见，当前候选尚未审阅衔接')).toBeTruthy()
})

it('只读禁用全部控件，点击不写入文档', async () => {
  const f = setup()
  f.doc.readOnly = true
  const { user } = renderNoteForm(f)
  expect((screen.getByRole('button', { name: '标记需修改' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  // happy-dom 里 fieldset 的禁用不反映到 input.disabled 属性，直接断言 fieldset
  expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true)
  expect((screen.getByRole('textbox', { name: '衔接意见备注' }) as HTMLInputElement).disabled).toBe(
    true,
  )
  await user.click(screen.getByRole('button', { name: '标记需修改' }))
  expect(f.doc.get(f.id)?.reviews ?? []).toEqual([])
})

it('没有可审候选时表单换成说明文字，观察入口保留', () => {
  const f = setup()
  renderNoteForm(f, { target: undefined })
  expect(screen.getByText('本镜还没有候选')).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: '服装' })).toBeNull()
  expect(screen.getByRole('button', { name: '回看切点并记录观察' })).toBeTruthy()
})
