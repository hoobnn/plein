import * as Y from 'yjs'
import type { NodeRuns } from '../runs/runs'
import type { RoomLease, Rooms } from '../sync/rooms'

/** 智能体会话写文档时用的事务 origin：撤销栈和改动集只认它 */
export class AgentOrigin {
  constructor(readonly sessionId: string) {}
}

/** 一轮对话对画布做的改动 */
export interface TurnChanges {
  created: string[]
  updated: string[]
  deleted: string[]
  /** 新增 + 删除的连线数 */
  edges: number
  runs: number
}

interface Pending {
  created: Set<string>
  updated: Set<string>
  deleted: Set<string>
  edges: number
  runs: Array<{ nodeId: string; runId: string }>
}

/**
 * 记录一个智能体会话对画布的改动，并能按轮撤销。
 *
 * - 撤销栈挂在房间的 Y.Doc 上，只追踪本会话的 origin；一轮的写入合并成一个栈项（meta.turn 标记轮次）。
 *   UndoManager 默认不覆盖别人后来写过的键，所以 AI 改完、用户又改过的地方撤销时保留用户的改动。
 * - 撤销栈必须在 AI 写入之前挂上（删除项要靠它保留，否则会被 GC），所以每轮开始时 attach。
 * - 持有房间租约期间房间不会卸载；释放租约后旧 Y.Doc 可能失效，撤销栈随之作废。
 */
export class AgentChanges {
  readonly origin: AgentOrigin
  private lease: RoomLease | null = null
  private undo: Y.UndoManager | null = null
  private detach: (() => void) | null = null
  private turn = ''
  private pending: Pending | null = null
  private turnRuns = new Map<string, Pending['runs']>()
  private touched = new Set<string>()
  private touchTimer: NodeJS.Timeout | null = null

  constructor(
    sessionId: string,
    private canvasId: string,
    private rooms: Rooms,
    private runs: NodeRuns,
    /** 改动了哪些元素（合并一小段时间内的改动再通知，用来在画布上高亮） */
    private onTouch?: (ids: string[]) => void,
  ) {
    this.origin = new AgentOrigin(sessionId)
  }

  get attached() {
    return this.undo !== null
  }

  /** 开始一轮：确保撤销栈已挂上，之后的写入归到这一轮 */
  begin(turn: string) {
    this.attach()
    this.undo!.stopCapturing()
    this.turn = turn
    this.pending = {
      created: new Set(),
      updated: new Set(),
      deleted: new Set(),
      edges: 0,
      runs: [],
    }
  }

  /** 这一轮发起了一次运行 */
  recordRun(nodeId: string, runId: string) {
    this.pending?.runs.push({ nodeId, runId })
  }

  /** 结束这一轮，返回改动摘要；什么都没改时返回 null */
  end(): TurnChanges | null {
    const p = this.pending
    this.pending = null
    this.undo?.stopCapturing()
    if (!p) return null
    if (p.runs.length) this.turnRuns.set(this.turn, p.runs)
    const changes: TurnChanges = {
      created: [...p.created],
      updated: [...p.updated].filter((id) => !p.created.has(id) && !p.deleted.has(id)),
      deleted: [...p.deleted],
      edges: p.edges,
      runs: p.runs.length,
    }
    const empty =
      !changes.created.length &&
      !changes.updated.length &&
      !changes.deleted.length &&
      !changes.edges &&
      !changes.runs
    return empty ? null : changes
  }

  /** 这一轮是否能撤销：只能从最近的一轮往回撤 */
  canUndo(turn: string): boolean {
    const top = this.undo?.undoStack.at(-1)
    return top?.meta.get('turn') === turn
  }

  /** 撤销一轮：先取消这一轮还在跑的运行，再回退文档改动 */
  undoTurn(turn: string): boolean {
    if (!this.undo || !this.canUndo(turn)) return false
    for (const { nodeId, runId } of this.turnRuns.get(turn) ?? []) {
      const live = this.rooms.withDoc(
        this.canvasId,
        (doc) => {
          const run = doc.get(nodeId)?.run
          return run?.id === runId && (run.status === 'queued' || run.status === 'running')
        },
        false,
      )
      if (live) this.runs.cancel(this.canvasId, nodeId)
    }
    this.turnRuns.delete(turn)
    while (this.canUndo(turn)) this.undo.undo()
    return true
  }

  /** 释放租约并作废撤销栈（会话空闲、画布删除时） */
  release() {
    if (this.touchTimer) clearTimeout(this.touchTimer)
    this.touchTimer = null
    this.touched.clear()
    this.detach?.()
    this.detach = null
    this.undo?.destroy()
    this.undo = null
    this.turnRuns.clear()
    this.lease?.release()
    this.lease = null
  }

  private touch(events: Array<Y.YEvent<Y.AbstractType<unknown>>>, elements: unknown) {
    if (!this.onTouch) return
    for (const ev of events) {
      if (ev.target === elements) {
        for (const [key, change] of ev.changes.keys)
          if (change.action !== 'delete') this.touched.add(key)
      } else if (typeof ev.path[0] === 'string') this.touched.add(ev.path[0])
    }
    if (this.touchTimer || !this.touched.size) return
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null
      const ids = [...this.touched]
      this.touched.clear()
      this.onTouch?.(ids)
    }, 120)
  }

  private attach() {
    if (this.undo) return
    this.lease = this.rooms.acquire(this.canvasId)
    const ydoc = this.lease.room.doc
    const elements = ydoc.getMap<Y.Map<unknown>>('elements')
    const edges = ydoc.getMap('edges')
    const undo = new Y.UndoManager([elements, edges], {
      trackedOrigins: new Set([this.origin]),
      // 一轮里工具调用间隔可能几秒到几分钟，靠 begin / end 里的 stopCapturing 分轮
      captureTimeout: Number.MAX_SAFE_INTEGER,
    })
    undo.on(
      'stack-item-added',
      (e: { stackItem: { meta: Map<string, unknown> }; type: string }) => {
        if (e.type === 'undo') e.stackItem.meta.set('turn', this.turn)
      },
    )
    const onElements = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction) => {
      const p = this.pending
      if (!p || tr.origin !== this.origin) return
      for (const ev of events) {
        if (ev.target === elements) {
          for (const [key, change] of ev.changes.keys) {
            if (change.action === 'add') p.created.add(key)
            else if (change.action === 'delete') {
              if (p.created.has(key)) p.created.delete(key)
              else p.deleted.add(key)
            } else p.updated.add(key)
          }
        } else {
          const id = ev.path[0]
          if (typeof id === 'string') p.updated.add(id)
        }
      }
      this.touch(events, elements)
    }
    const onEdges = (ev: Y.YMapEvent<unknown>, tr: Y.Transaction) => {
      if (this.pending && tr.origin === this.origin) this.pending.edges += ev.keysChanged.size
    }
    elements.observeDeep(onElements)
    edges.observe(onEdges)
    this.detach = () => {
      elements.unobserveDeep(onElements)
      edges.unobserve(onEdges)
    }
    this.undo = undo
  }
}
