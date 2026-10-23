import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import { createDoc, createElement, setParam, setParamEntry } from './index'

describe('稀疏参数字段协作', () => {
  it('首次创建与整体重置都保留共享字典，独立修改双向收敛', () => {
    const a = createDoc()
    const id = createElement(a, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      params: { overrides: {} },
    })
    expect((a.mutable(id)!.get('params') as Y.Map<unknown>).get('overrides')).toBeInstanceOf(Y.Map)
    setParam(a, id, 'overrides', { 'hf-title.text': '重置' })
    expect((a.mutable(id)!.get('params') as Y.Map<unknown>).get('overrides')).toBeInstanceOf(Y.Map)
    const b = createDoc()
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))
    setParamEntry(a, id, 'overrides', 'hf-title.text', '甲')
    setParamEntry(b, id, 'overrides', 'hf-subtitle.text', '乙')
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc))
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))
    expect(a.get(id)?.params?.overrides).toEqual({
      'hf-title.text': '甲',
      'hf-subtitle.text': '乙',
    })
    expect(b.get(id)?.params?.overrides).toEqual(a.get(id)?.params?.overrides)
    a.destroy()
    b.destroy()
  })

  it('条目删除与撤销只影响本地条目，远端修改仍保留', () => {
    const a = createDoc()
    const id = createElement(a, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      params: { overrides: { a: 1, b: 2 } },
    })
    a.undo.stopCapturing()
    const b = createDoc()
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))
    setParamEntry(a, id, 'overrides', 'a', undefined)
    setParamEntry(b, id, 'overrides', 'b', 3)
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc))
    expect(a.get(id)?.params?.overrides).toEqual({ b: 3 })
    a.undo.undo()
    expect(a.get(id)?.params?.overrides).toEqual({ a: 1, b: 3 })
    a.destroy()
    b.destroy()
  })
})
