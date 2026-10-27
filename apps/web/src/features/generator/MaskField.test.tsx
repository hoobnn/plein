// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { connect, createElement, type PleinDoc, setParam, updateElement } from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import type { EditMask } from '@plein/nodes'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen } from '../../testing/render'
import { useCanvas } from '../../stores/canvas'
import { upstreams } from '../../canvas/nodes'
import type { MaskEditor } from './MaskEditor'
import { MaskField } from './MaskField'

const editor = vi.hoisted(() => ({ props: null as ComponentProps<typeof MaskEditor> | null }))
// 会话守卫的外部边界是画板；真实绘制与上传由 MaskEditor.test.tsx 覆盖。
vi.mock('./MaskEditor', () => ({
  MaskEditor: (props: ComponentProps<typeof MaskEditor>) => {
    editor.props = props
    return (
      <div role="dialog" aria-label="画板会话">
        <button type="button" onClick={props.onClose}>
          取消画板
        </button>
      </div>
    )
  },
}))
const docs: PleinDoc[] = []
afterEach(() => {
  docs.splice(0).forEach((doc) => doc.destroy())
  editor.props = null
})
const original: EditMask = {
  assetId: 'prior-mask',
  sourceAssetId: 'source',
  width: 160,
  height: 96,
}
const next: EditMask = { ...original, assetId: 'new-mask' }
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const source = createElement(doc, box({ assetId: 'source' }))
  const id = createElement(
    doc,
    node({
      nodeType: 'plein/image-edit',
      params: { mask: original },
      ports: {
        inputs: [{ id: 'image', type: 'image', label: '原图' }],
        outputs: [],
      },
    }),
  )
  connect(doc, [source, 'image'], [id, 'image'])
  const engine = { doc } as Engine
  const ui = () => (
    <MaskField
      engine={engine}
      el={doc.get(id)!}
      source={upstreams(engine, id, null).get('image')?.[0]}
    />
  )
  const view = renderApp(ui())
  return { ...view, doc, id, source, redraw: () => view.rerender(ui()) }
}

it('协作改名保持初始蒙版身份和本地会话，保存只更新蒙版参数', async () => {
  const f = setup()
  await f.user.click(screen.getAllByRole('button', { name: '重画区域' })[0]!)
  const initial = editor.props!.initial
  act(() => updateElement(f.doc, f.id, { name: '协作改名' }))
  f.redraw()
  expect(editor.props!.initial).toBe(initial)
  expect(screen.getByRole('dialog')).toBeTruthy()
  act(() => editor.props!.onSave(next))
  expect(f.doc.get(f.id)!.params!.mask).toEqual(next)
  expect(f.doc.get(f.id)!.name).toBe('协作改名')
  expect(screen.queryByRole('dialog')).toBeNull()
})

for (const change of ['mask', 'instance', 'source', 'readonly', 'delete'] as const) {
  for (const renderBeforeSave of [false, true]) {
    it(`${change} 在${renderBeforeSave ? '编辑' : '保存回调'}期间变化不覆盖新状态`, async () => {
      const f = setup()
      await f.user.click(screen.getAllByRole('button', { name: '重画区域' })[0]!)
      const staleSave = editor.props!.onSave
      act(() => {
        if (change === 'mask') setParam(f.doc, f.id, 'mask', null)
        if (change === 'instance') f.doc.elementMaps.set(f.id, f.doc.mutable(f.id)!.clone())
        if (change === 'source') updateElement(f.doc, f.source, { assetId: 'replacement' })
        if (change === 'readonly') f.doc.readOnly = true
        if (change === 'delete') f.doc.elementMaps.delete(f.id)
      })
      if (renderBeforeSave && change !== 'delete') {
        f.redraw()
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(useCanvas.getState().notice).toBeTruthy()
      }
      expect(() => staleSave(next)).toThrow()
      expect(f.doc.get(f.id)?.params?.mask).toEqual(
        change === 'delete' ? undefined : change === 'mask' ? null : original,
      )
      if (renderBeforeSave && change !== 'delete' && change !== 'readonly') {
        await f.user.click(
          screen.getAllByRole('button', { name: change === 'mask' ? '画区域' : '重画区域' })[0]!,
        )
        expect(screen.getByRole('dialog')).toBeTruthy()
        expect(editor.props!.initial).toEqual(
          change === 'mask' || change === 'source' ? null : original,
        )
      }
    })
  }
}
