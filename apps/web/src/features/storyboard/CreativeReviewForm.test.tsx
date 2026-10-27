// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  createElement,
  deleteElements,
  getCreativeReview,
  creativeReviewTarget,
  type PleinDoc,
} from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { LOCAL_PRINCIPAL } from '@plein/protocol'
import { afterEach, expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { act, fireEvent, renderApp, screen } from '../../testing/render'
import { CreativeReviewForm } from './CreativeReviewForm'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

function setup() {
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(
    doc,
    node({
      nodeType: 'plein/image',
      name: '验收绑定',
      params: {},
      ports: { inputs: [], outputs: [{ id: 'images', label: '图片', type: 'image' }] },
    }),
  )
  addResults(doc, id, [
    {
      id: 'review-result',
      runId: 'fixture',
      port: 'images',
      value: { type: 'image', assetId: 'a'.repeat(64) },
      at: 1,
    },
  ])
  useCanvas.setState({ engine: { doc } as unknown as Engine })
  useSession.setState({
    info: { principal: LOCAL_PRINCIPAL, authRequired: false, needsSetup: false },
  })
  function Harness() {
    useDocVersion(doc)
    const element = doc.get(id)
    return element ? (
      <CreativeReviewForm doc={doc} node={element} defaultOpen />
    ) : (
      <p role="status">来源节点已删除，恢复节点后可继续审片。</p>
    )
  }
  const rendered = renderApp(<Harness />)
  return {
    doc,
    id,
    ...rendered,
    note: () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: /创作验收备注/ }),
    save: (status: '可用' | '需修改' = '可用') =>
      screen.getByRole<HTMLButtonElement>('button', { name: '保存为' + status }),
    summary: () => document.querySelector('[data-review-node] summary')!,
  }
}

it('只读竞态不写入，恢复后同实例草稿保留且保存可撤销重做', () => {
  const f = setup()
  fireEvent.change(f.note(), { target: { value: '尚未保存的意见' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /^构图$/ }))
  f.doc.readOnly = true
  fireEvent.click(f.save())
  expect(screen.getByRole('alert').textContent).toContain('只读')
  expect(f.doc.get(f.id)?.reviews ?? []).toEqual([])

  f.doc.readOnly = false
  act(() => {
    f.doc.mutable(f.id)!.set('rotation', 15)
    f.doc.flush()
  })
  expect(f.note().value).toBe('尚未保存的意见')
  fireEvent.click(f.save('需修改'))
  act(() => f.doc.flush())
  expect(f.summary().textContent).toContain('需修改')
  expect(getCreativeReview(f.doc.get(f.id))?.note).toBe('尚未保存的意见')

  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.summary().textContent).toContain('待审')
  act(() => {
    f.doc.undo.redo()
    f.doc.flush()
  })
  expect(f.summary().textContent).toContain('需修改')
  expect(f.note().value).toBe('尚未保存的意见')
  expect(f.doc.get(f.id)?.rotation).toBe(15)
})

it('节点替换使旧按钮失效，清除草稿后可重新记录', () => {
  const f = setup()
  fireEvent.change(f.note(), { target: { value: '旧实例草稿' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /^构图$/ }))
  const stale = f.save()
  act(() => {
    f.doc.ydoc.transact(
      () => f.doc.elementMaps.set(f.id, f.doc.mutable(f.id)!.clone()),
      f.doc.origin,
    )
    fireEvent.click(stale)
    f.doc.flush()
  })

  expect(f.note().value).toBe('')
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^构图$/ }).checked).toBe(false)
  expect(screen.getByRole('status').textContent).toContain('草稿已清除')
  expect(f.doc.get(f.id)?.reviews ?? []).toEqual([])

  fireEvent.change(f.note(), { target: { value: '核对当前素材后的意见' } })
  fireEvent.click(f.save('需修改'))
  act(() => f.doc.flush())
  expect(f.summary().textContent).toContain('需修改')
  expect(getCreativeReview(f.doc.get(f.id))?.note).toBe('核对当前素材后的意见')
})

it('来源删除时旧按钮不写入，撤销恢复后重新记录', () => {
  const f = setup()
  fireEvent.change(f.note(), { target: { value: '删除前草稿' } })
  const stale = f.save()
  f.doc.undo.stopCapturing()
  act(() => {
    deleteElements(f.doc, [f.id])
    fireEvent.click(stale)
    f.doc.flush()
  })
  expect(f.doc.get(f.id)).toBeUndefined()
  expect(screen.queryByRole('textbox', { name: /创作验收备注/ })).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('来源节点已删除')

  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.note().value).toBe('')
  fireEvent.change(f.note(), { target: { value: '删除恢复后重新确认' } })
  fireEvent.click(f.save())
  act(() => f.doc.flush())
  expect(f.summary().textContent).toContain('可用')
  expect(getCreativeReview(f.doc.get(f.id), creativeReviewTarget(f.doc.get(f.id)))?.note).toBe(
    '删除恢复后重新确认',
  )
})
