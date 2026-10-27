import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, deleteElements, type NodeResult } from '@plein/doc'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { watchVideoAspect } from './videoAspect'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const result = (assetId: string): NodeResult => ({
  id: assetId,
  port: 'video',
  value: { type: 'video', assetId },
  runId: assetId,
  at: 1,
})
function setup() {
  const doc = createDoc(undefined, { schedule: () => {} })
  const add = (assetId: string) => {
    const id = createElement(doc, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      results: [result(assetId)],
    })
    doc.flush()
    return id
  }
  const change = (id: string, assetId: string) => {
    doc.ydoc.transact(() => doc.mutable(id)!.set('results', [result(assetId)]))
    doc.flush()
  }
  const ratioOf = vi.fn(async () => 2)
  const off = watchVideoAspect({ doc } as Engine, ratioOf)
  cleanups.push(() => {
    off()
    doc.destroy()
    doc.ydoc.destroy()
  })
  return { doc, add, change, ratioOf, off }
}

describe('视频比例缓存生命周期', () => {
  it('连续换结果后历史比例可回收，重访重新读取而当前结果仍复用', async () => {
    const { doc, add, change, ratioOf } = setup()
    const id = add('video-0')
    for (let i = 1; i < 100; i++) change(id, `video-${i}`)
    await Promise.resolve()
    doc.flush()
    expect(ratioOf).toHaveBeenCalledTimes(100)
    // 重访每一项：只有最后一项仍活跃，其余都必须重新取尺寸。
    for (let i = 99; i >= 0; i--) {
      const other = add(`video-${i}`)
      deleteElements(doc, [other])
      doc.flush()
    }
    expect(ratioOf).toHaveBeenCalledTimes(199)
  })

  it('共享视频的多个节点只读一次，最后一个引用删除后才释放', async () => {
    const { doc, add, change, ratioOf } = setup()
    const first = add('shared')
    const second = add('shared')
    expect(ratioOf).toHaveBeenCalledTimes(1)
    change(first, 'next')
    const third = add('shared')
    expect(ratioOf).toHaveBeenCalledTimes(2)
    deleteElements(doc, [second, third])
    doc.flush()
    add('shared')
    expect(ratioOf).toHaveBeenCalledTimes(3)
    await Promise.resolve()
    await Promise.resolve()
    expect(doc.get(first)!.w / doc.get(first)!.h).toBe(2)
  })

  it('结果切换后拒绝旧异步尺寸，解绑注销订阅且不写入在途响应', async () => {
    const { doc, add, change, ratioOf, off } = setup()
    let complete!: (ratio: number) => void
    ratioOf.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    const id = add('slow')
    change(id, 'current')
    await Promise.resolve()
    await Promise.resolve()
    expect(doc.get(id)!.w / doc.get(id)!.h).toBe(2)
    complete(0.5)
    await Promise.resolve()
    await Promise.resolve()
    expect(doc.get(id)!.w / doc.get(id)!.h).toBe(2)

    ratioOf.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    change(id, 'pending')
    off()
    complete(0.5)
    await Promise.resolve()
    await Promise.resolve()
    expect(doc.get(id)!.w / doc.get(id)!.h).toBe(2)
    add('after-stop')
    expect(ratioOf).toHaveBeenCalledTimes(3)
  })
})
