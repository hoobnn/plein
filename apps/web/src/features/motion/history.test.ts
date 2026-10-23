import { createDoc, createElement, setParamEntry } from '@plein/doc'
import { MotionParams, MOTION_TYPE } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import {
  applyMotionHistory,
  canMotionHistory,
  watchMotionHistory,
  writeMotionEdit,
} from './history'

describe('动态合成的唯一撤销栈', () => {
  it('一次关联时间编辑只撤销一次，独立客户端的另一字段保留', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const off = watchMotionHistory(doc)
    const id = createElement(doc, {
      kind: 'node',
      nodeType: MOTION_TYPE,
      params: MotionParams.parse({}),
      x: 0,
      y: 0,
      w: 320,
      h: 240,
    })
    // 先建立嵌套共享Map，再让两个客户端独立编辑，模拟已打开的同一个源版本。
    setParamEntry(doc, id, 'overrides', 'hf-title.style.left', '8%')
    doc.undo.clear()
    const remote = createDoc(undefined, { schedule: () => {} })
    Y.applyUpdate(remote.ydoc, Y.encodeStateAsUpdate(doc.ydoc))
    writeMotionEdit(doc, id, () => {
      setParamEntry(doc, id, 'overrides', 'hf-title.timing.start', 1)
      setParamEntry(doc, id, 'overrides', 'hf-title.timing.end', 4)
    })
    setParamEntry(remote, id, 'overrides', 'hf-subtitle.style.top', '75%')
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(remote.ydoc), 'remote')
    expect(doc.undo.undoStack).toHaveLength(1)
    expect(canMotionHistory(doc, id, 'undo')).toBe(true)
    applyMotionHistory(doc, id, 'undo')
    doc.flush()
    expect(doc.get(id)?.params?.overrides).toEqual({
      'hf-title.style.left': '8%',
      'hf-subtitle.style.top': '75%',
    })
    applyMotionHistory(doc, id, 'redo')
    doc.flush()
    expect(doc.get(id)?.params?.overrides).toMatchObject({
      'hf-title.timing.start': 1,
      'hf-title.timing.end': 4,
      'hf-subtitle.style.top': '75%',
    })
    off()
    remote.destroy()
    doc.destroy()
  })
})
