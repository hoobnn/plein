// @vitest-environment happy-dom
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { PreparedInput } from '@plein/protocol'
import { applyUpdate, encodeStateAsUpdate } from 'yjs'
import { expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { act, renderApp, screen } from '../../testing/render'
import { mediaTestEngine } from '../../shell/media-tools/testEngine'
import { RoleReferencePicker } from './RoleReferencePicker'

it('角色选图按资产保存，重排和文档重开不改变选择；可仅文字、自动选择或撤销', async () => {
  const doc = openDoc()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    params: {},
  })
  const engine = mediaTestEngine(doc)
  let available = ['first', 'second']
  function Harness() {
    useDocVersion(doc)
    const data = {
      refs: [{ kind: 'character', elementId: 'hero', name: '角色', available, sent: [] }],
    } as unknown as PreparedInput
    return <RoleReferencePicker engine={engine} nodeId={id} data={data} />
  }
  try {
    const { user, rerender } = renderApp(<Harness />)
    await user.click(screen.getByRole('button', { name: '角色参考图' }))
    await user.click(screen.getByRole('option', { name: '选择角色第2张参考图' }))
    act(() => doc.flush())
    expect(doc.get(id)?.params?.referenceImagePicks).toEqual({ hero: ['second'] })
    available = ['second', 'first']
    rerender(<Harness />)
    expect(
      screen.getByRole('option', { name: '选择角色第1张参考图' }).getAttribute('aria-selected'),
    ).toBe('true')
    const reopened = openDoc()
    try {
      applyUpdate(reopened.ydoc, encodeStateAsUpdate(doc.ydoc))
      expect(reopened.get(id)?.params?.referenceImagePicks).toEqual({ hero: ['second'] })
    } finally {
      reopened.destroy()
    }
    await user.click(screen.getByRole('button', { name: '仅文字' }))
    expect(doc.get(id)?.params?.referenceImagePicks).toEqual({ hero: [] })
    act(() => {
      doc.undo.undo()
      doc.flush()
    })
    expect(doc.get(id)?.params?.referenceImagePicks).toEqual({ hero: ['second'] })
    await user.click(screen.getByRole('button', { name: '恢复自动' }))
    expect(doc.get(id)?.params?.referenceImagePicks).toEqual({})
  } finally {
    doc.destroy()
  }
})

it('多选：自动模式点一张以自动选中的图为起点，保存按卡片顺序；全取消是仅文字，同角色多处引用只显示一组', async () => {
  const doc = openDoc()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    params: {},
  })
  const engine = mediaTestEngine(doc)
  function Harness() {
    useDocVersion(doc)
    const data = {
      refs: [
        { kind: 'character', elementId: 'hero', name: '角色', available: ['a', 'b'], sent: ['a'] },
        {
          kind: 'character',
          elementId: 'hero',
          name: '角色（少年）',
          available: ['c', 'b'],
          sent: ['c'],
        },
      ],
    } as unknown as PreparedInput
    return <RoleReferencePicker engine={engine} nodeId={id} data={data} />
  }
  try {
    const { user } = renderApp(<Harness />)
    await user.click(screen.getByRole('button', { name: '角色参考图' }))
    expect(screen.getAllByRole('region', { name: /参考图$/ })).toHaveLength(1)
    const option = (n: number) =>
      screen.getByRole('option', { name: `选择角色第${n}张参考图` }).getAttribute('aria-selected')
    // 自动：勾选的是自动送入的 a、c
    expect([option(1), option(2), option(3)]).toEqual(['true', 'false', 'true'])
    await user.click(screen.getByRole('option', { name: '选择角色第2张参考图' }))
    act(() => doc.flush())
    expect(doc.get(id)?.params?.referenceImagePicks).toEqual({ hero: ['a', 'b', 'c'] })
    expect(screen.getByText('已选 3 张')).toBeTruthy()
    for (const n of [1, 2, 3]) {
      await user.click(screen.getByRole('option', { name: `选择角色第${n}张参考图` }))
      act(() => doc.flush())
    }
    expect(doc.get(id)?.params?.referenceImagePicks).toEqual({ hero: [] })
    expect(screen.getByText('仅文字，不带图')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '恢复自动' }))
    expect(doc.get(id)?.params?.referenceImagePicks).toEqual({})
  } finally {
    doc.destroy()
  }
})
