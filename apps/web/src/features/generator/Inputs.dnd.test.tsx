// @vitest-environment happy-dom
import { connect, createElement, inputEdges, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import type { NodeInfo } from '../../canvas/nodes'
import { upstreams } from '../../canvas/nodes'
import { mediaTestEngine } from '../../shell/media-tools/testEngine'
import { act, fireEvent, renderApp, screen, within } from '../../testing/render'
import { Inputs } from './Inputs'

describe('参考图拖拽排序（dnd-kit）', () => {
  let doc: PleinDoc
  afterEach(() => doc?.destroy())

  /** 每项一条连线（指定端口），每条连线新建一个素材；返回素材 id 按连线顺序 */
  function setup(connections: string[] = ['images', 'images', 'images']) {
    doc = openDoc()
    const ports = [
      { id: 'images', label: '图片', type: 'image', multiple: true },
      { id: 'cover', label: '封面', type: 'image', multiple: false },
    ].filter((p) => connections.includes(p.id))
    const node = {
      type: 'plein/video',
      capability: 'video.generate',
      defaults: {},
      inputs: ports,
      outputs: [],
    } as unknown as NodeInfo
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      ports: { inputs: node.inputs, outputs: [] },
      x: 0,
      y: 0,
      w: 160,
      h: 90,
      params: { prompt: '参考' },
    })
    const sources: string[] = []
    for (const [i, portId] of connections.entries()) {
      const source = createElement(doc, {
        kind: 'image',
        name: `素材${i}`,
        assetId: `asset${i}`,
        x: i * 200,
        y: 150,
        w: 160,
        h: 90,
      })
      connect(doc, [source, 'image'], [id, portId])
      sources.push(source)
    }
    const engine = mediaTestEngine(doc)
    function Harness() {
      useDocVersion(engine.doc)
      const ups = upstreams(engine, id, null)
      return <Inputs engine={engine} el={doc.get(id)!} node={node} ups={ups} />
    }
    renderApp(<Harness />)
    return { id, engine, sources, doc }
  }

  /** 用假几何替身布置瓦片矩形：第 i 块落在 [i*120, i*120+48]，间距大于瓦片宽度保证碰撞唯一 */
  function stubTileRects() {
    const tiles = screen.getAllByRole('group')
    tiles.forEach((el, i) => {
      vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(i * 120, 0, 48, 48),
      )
    })
    return tiles
  }

  /** 指针拖动：压下 → 越过 8px 激活门槛 → 移到目标坐标 → 松手 */
  async function dragTile(fromIndex: number, toClientX: number) {
    const tiles = screen.getAllByRole('group')
    const button = within(tiles[fromIndex]!).getByRole('button', { name: /预览/ })
    const startX = fromIndex * 120 + 24
    fireEvent.pointerDown(button, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      pointerType: 'mouse',
      clientX: startX,
      clientY: 24,
    })
    fireEvent.pointerMove(button, { pointerId: 1, clientX: startX - 10, clientY: 24 })
    await act(async () => {})
    fireEvent.pointerMove(document, { pointerId: 1, clientX: toClientX, clientY: 24 })
    await act(async () => {})
    fireEvent.pointerUp(document, { pointerId: 1, clientX: toClientX, clientY: 24 })
    await act(async () => {})
  }

  it('拖到前一格放下：连线按新顺序重排，且撤销一次恢复原顺序', async () => {
    const f = setup()
    const tiles = stubTileRects()
    expect(tiles.length).toBe(3)
    const order = () => inputEdges(f.doc, f.id, 'images').map((edge) => edge.from[0])
    expect(order()).toEqual(f.sources)
    // 第 1 块拖到第 0 块的位置（x=24 落在 [0,48]）
    await dragTile(1, 24)
    expect(order()).toEqual([f.sources[1], f.sources[0], f.sources[2]])
    // 一次撤销回到原顺序：整个拖放是一个撤销分组
    act(() => {
      f.doc.undo.undo()
    })
    expect(order()).toEqual(f.sources)
  })

  it('拖拽激活后按 Esc 取消：不写文档、不产生撤销分组，退出拖拽态', async () => {
    const f = setup()
    stubTileRects()
    const order = () => inputEdges(f.doc, f.id, 'images').map((edge) => edge.from[0])
    const stackSize = () => f.doc.undo.undoStack.length
    const before = stackSize()
    const tiles = screen.getAllByRole('group')
    const button = within(tiles[1]!).getByRole('button', { name: /预览/ })
    fireEvent.pointerDown(button, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      pointerType: 'mouse',
      clientX: 144,
      clientY: 24,
    })
    // 越过 8px 激活约束：被拖瓦片进入拖拽态（isDragging → zIndex），
    // 证明后面的 Esc 走的是真实取消路径而非空操作
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 130, clientY: 24 })
    await act(async () => {})
    expect(tiles[1]!.style.zIndex).toBe('1')
    // 库按 event.code 匹配 Esc
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await act(async () => {})
    expect(order()).toEqual(f.sources)
    expect(stackSize()).toBe(before)
    expect(tiles[1]!.style.zIndex).toBe('')
  })

  it('非 multiple 端口的参考不可拖：拖动尝试不改顺序、不产生撤销分组', async () => {
    const f = setup(['images', 'cover'])
    const tiles = stubTileRects()
    const order = () => inputEdges(f.doc, f.id, 'cover').map((edge) => edge.from[0])
    const stackSize = () => f.doc.undo.undoStack.length
    expect(order()).toEqual([f.sources[1]])
    const before = stackSize()
    // 尝试把「封面」瓦片拖到图片瓦片的位置
    await dragTile(1, 24)
    expect(order()).toEqual([f.sources[1]])
    expect(inputEdges(f.doc, f.id, 'images').map((edge) => edge.from[0])).toEqual([f.sources[0]])
    expect(stackSize()).toBe(before)
    // 没有进入拖拽态：瓦片不带排序位移
    expect(tiles[1]!.style.transform).toBe('')
  })
})
