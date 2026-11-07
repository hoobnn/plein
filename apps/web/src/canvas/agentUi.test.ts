import type { Engine } from '@plein/canvas-core'
import { describe, expect, it } from 'vite-plus/test'
import { watchAgentUi } from './agentUi'

type Awareness = Parameters<typeof watchAgentUi>[0]

/** 最小 awareness：本地写入的字段留在 local，远端状态由测试放进 remote 并触发 change */
function fakeAwareness(clientID: number) {
  const remote = new Map<number, unknown>()
  const local: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  const awareness = {
    clientID,
    getStates: () => remote,
    on: (_: string, fn: () => void) => listeners.add(fn),
    off: (_: string, fn: () => void) => listeners.delete(fn),
    setLocalStateField: (k: string, v: unknown) => {
      local[k] = v
    },
  }
  return {
    awareness: awareness as unknown as Awareness,
    local,
    push: (action: Record<string, unknown>, n: number) => {
      remote.set(999, { agentUi: { actions: [{ n, ...action }] } })
      for (const fn of listeners) fn()
    },
  }
}

/** undoDepth / redoDepth 模拟 Yjs UndoManager 的两个栈 */
function fakeEngine(undoDepth: number, redoDepth = 0) {
  return {
    undoDepth,
    redoDepth,
    get state() {
      return { canUndo: this.undoDepth > 0, canRedo: this.redoDepth > 0 }
    },
    undo() {
      this.undoDepth--
      this.redoDepth++
    },
    redo() {
      this.redoDepth--
      this.undoDepth++
    },
  }
}

describe('watchAgentUi ui_undo', () => {
  it('按步数撤销并回传实际步数与剩余状态；栈不够时只做能做的', () => {
    const f = fakeAwareness(1)
    const engine = fakeEngine(2)
    watchAgentUi(f.awareness, engine as unknown as Engine)
    f.push({ action: 'undo', client: 1, steps: 5, redo: false }, 1)
    expect(f.local.agentUiReply).toEqual({ n: 1, done: 2, can_undo: false, can_redo: true })
    expect(engine.undoDepth).toBe(0)
  })

  it('redo 走重做栈；栈为空返回 done 0 且不报错', () => {
    const f = fakeAwareness(1)
    const engine = fakeEngine(0, 1)
    watchAgentUi(f.awareness, engine as unknown as Engine)
    f.push({ action: 'undo', client: 1, steps: 1, redo: true }, 1)
    expect(f.local.agentUiReply).toEqual({ n: 1, done: 1, can_undo: true, can_redo: false })
    f.push({ action: 'undo', client: 1, steps: 3, redo: true }, 2)
    expect(f.local.agentUiReply).toEqual({ n: 2, done: 0, can_undo: true, can_redo: false })
  })

  it('指定给别的标签页的动作不执行也不回传', () => {
    const f = fakeAwareness(1)
    const engine = fakeEngine(3)
    watchAgentUi(f.awareness, engine as unknown as Engine)
    f.push({ action: 'undo', client: 2, steps: 1, redo: false }, 1)
    expect(engine.undoDepth).toBe(3)
    expect(f.local.agentUiReply).toBeUndefined()
  })
})
