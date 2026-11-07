import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, createCanvas } from '../testing'
import { requestUndo } from './ui-bridge'
import { serverCapabilities, serverContext, type ToolEnv } from './tools'

function envOf(
  server: Awaited<ReturnType<typeof bootServer>>['server'],
  canvasId: string,
): ToolEnv {
  return {
    canvasId,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    library: server.library,
    mediaIndex: server.mediaIndex,
    checkpoints: server.checkpoints,
    canvasApi: server.canvasApi,
  }
}

const VIEW = { selection: [], viewport: { x: 0, y: 0, w: 800, h: 600 } }

/** 模拟浏览器标签页：经 awareness 更新发布 view，收到指给自己的 undo 动作后写回结果 */
function fakeTab(server: Awaited<ReturnType<typeof bootServer>>['server'], canvasId: string) {
  const awareness = server.rooms.get(canvasId).awareness
  const tab = new awarenessProtocol.Awareness(new Y.Doc())
  const stack = { undo: 3, redo: 0 }
  const received: Array<Record<string, unknown>> = []
  const send = () =>
    awarenessProtocol.applyAwarenessUpdate(
      awareness,
      awarenessProtocol.encodeAwarenessUpdate(tab, [tab.clientID]),
      'tab',
    )
  const publish = (at: number) => {
    tab.setLocalStateField('view', { ...VIEW, at })
    send()
  }
  publish(Date.now())
  let last = 0
  awareness.on('change', () => {
    const actions = (
      awareness.getLocalState()?.agentUi as { actions?: Array<Record<string, unknown>> }
    )?.actions
    const a = actions?.at(-1)
    if (!a || a.action !== 'undo' || a.client !== tab.clientID || (a.n as number) <= last) return
    last = a.n as number
    received.push(a)
    let done = 0
    while (done < (a.steps as number) && (a.redo ? stack.redo : stack.undo) > 0) {
      if (a.redo) {
        stack.redo--
        stack.undo++
      } else {
        stack.undo--
        stack.redo++
      }
      done++
    }
    tab.setLocalStateField('agentUiReply', {
      n: a.n,
      done,
      can_undo: stack.undo > 0,
      can_redo: stack.redo > 0,
    })
    send()
  })
  return { tab, stack, received, publish }
}

describe('ui_undo', () => {
  it('没有打开画布的界面时返回与其它 ui 工具一致的提示', async () => {
    const { server } = await bootServer()
    const { id } = await createCanvas(server)
    const env = envOf(server, id)
    const out = await serverCapabilities.invoke('ui_undo', serverContext(env), {})
    expect(out).toContain('没有在浏览器')
  })

  it('推给最近活跃的标签页执行并回传结果；栈为空返回 done 0 与说明', async () => {
    const { server } = await bootServer()
    const { id } = await createCanvas(server)
    const t = fakeTab(server, id)
    const env = envOf(server, id)
    const run = (a: unknown) => serverCapabilities.invoke('ui_undo', serverContext(env), a)
    expect(await run({ steps: 2 })).toMatchObject({ done: 2, can_undo: true, can_redo: true })
    expect(t.received[0]).toMatchObject({ steps: 2, redo: false })
    expect(await run({ steps: 5, redo: true })).toMatchObject({
      done: 2,
      can_undo: true,
      can_redo: false,
    })
    expect(await run({ steps: 20, redo: true })).toMatchObject({
      done: 0,
      note: '没有可重做的操作',
    })
  })

  it('标签页不回应时超时报错', async () => {
    const { server } = await bootServer()
    const { id } = await createCanvas(server)
    const tab = new awarenessProtocol.Awareness(new Y.Doc())
    tab.setLocalStateField('view', { ...VIEW, at: Date.now() })
    awarenessProtocol.applyAwarenessUpdate(
      server.rooms.get(id).awareness,
      awarenessProtocol.encodeAwarenessUpdate(tab, [tab.clientID]),
      'tab',
    )
    await expect(requestUndo(server.rooms, id, { steps: 1, redo: false }, 30)).rejects.toThrow(
      '没有响应',
    )
  })

  it('步数范围受限；effect 为 edit 而不是 destructive', () => {
    const cap = serverCapabilities.get('ui_undo')!
    expect(cap.effect).toBe('edit')
    expect(cap.input.safeParse({ steps: 0 }).success).toBe(false)
    expect(cap.input.safeParse({ steps: 21 }).success).toBe(false)
    expect(cap.input.parse({})).toEqual({ steps: 1, redo: false })
  })
})
