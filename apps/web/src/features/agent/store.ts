import {
  API,
  type AgentAccess,
  type AgentApprovalMode,
  type AgentEvent,
  type AgentKind,
  type AgentSession,
  type AgentSessionSummary,
  type AgentStatus,
  type EditScope,
} from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'

/** 吉祥物的心情：跟着智能体的状态走 */
export type Mood = 'idle' | 'working' | 'happy' | 'sad'

const AGENT_KEY = 'plein:agent'
const APPROVAL_KEY = 'plein:agent-approval'
const PLAN_KEY = 'plein:agent-plan'
const ACCESS_KEY = 'plein:agent-access'

interface AgentStore {
  open: boolean
  status: AgentStatus | null
  /** 新建对话用的 CLI，记在本机 */
  agent: AgentKind
  /** 花钱、删东西前要不要先问，记在本机 */
  approval: AgentApprovalMode
  /** 计划模式：先列计划，同意后才动手，记在本机 */
  plan: boolean
  /** 本机 CLI 能不能不问就改文件、跑命令 */
  access: AgentAccess
  canvasId: string | null
  sessions: AgentSessionSummary[]
  session: AgentSession | null
  /** 面板关着时有新回复 */
  unread: boolean
  mood: Mood
  /** 小满刚改过的元素：画布上的 AI 光标飘过去 */
  cursor: { ids: string[]; at: number } | null
  error: string | null
  toggle(open?: boolean): void
  /** 输入框要抢焦点的次数：「让小满处理」打开面板时加一 */
  focusSeq: number
  /** 打开面板并把光标放进输入框（带上当前选区） */
  ask(): void
  loadStatus(refresh?: boolean): Promise<void>
  setAgent(agent: AgentKind): void
  setApproval(mode: AgentApprovalMode): void
  setPlan(plan: boolean): void
  setAccess(access: AgentAccess): void
  /** 允许或跳过一张确认单；修改方案允许时带上批准范围 */
  decide(approvalId: string, allow: boolean, scope?: EditScope): Promise<void>
  /** 切换到某块画布（null 表示不在画布里）：读它的会话，接上最近一个 */
  enter(canvasId: string | null): Promise<void>
  select(id: string): Promise<void>
  /** 开一个空白对话（发第一条消息时才真正创建） */
  reset(): void
  send(text: string, selection?: string[]): Promise<void>
  stop(): Promise<void>
  /** 撤销某一轮对画布的改动 */
  undoTurn(turn: string): Promise<void>
  remove(id: string): Promise<void>
}

let source: EventSource | null = null
/** 每次进入画布、切换会话都加一，晚到的应答对不上就丢掉 */
let selectSeq = 0
let moodTimer: ReturnType<typeof setTimeout> | undefined

function savedApproval(): AgentApprovalMode {
  try {
    const v = localStorage.getItem(APPROVAL_KEY)
    return v === 'always' || v === 'auto' ? v : 'rules'
  } catch {
    return 'rules'
  }
}

function savedAccess(): AgentAccess {
  try {
    return localStorage.getItem(ACCESS_KEY) === 'full' ? 'full' : 'auto'
  } catch {
    return 'auto'
  }
}

function savedFlag(key: string) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** 记住的智能体；没记过时用内置的（不用装 CLI），状态读回来后不可用再换 */
function savedAgent(): AgentKind {
  try {
    const v = localStorage.getItem(AGENT_KEY)
    return v === 'claude' || v === 'codex' ? v : 'builtin'
  } catch {
    return 'builtin'
  }
}

export const useAgent = create<AgentStore>((set, get) => {
  /** 订阅会话事件流；同一时间只连一个会话 */
  const connect = (id: string | null) => {
    source?.close()
    source = null
    if (!id) return
    const es = new EventSource(API.agentEvents(id))
    source = es
    es.onerror = () => {
      // 浏览器会自动重连；连接彻底关闭时才算断开
      if (source === es && es.readyState === EventSource.CLOSED)
        set({ error: '与智能体的连接已断开，请重新打开对话' })
    }
    es.onmessage = (msg) => {
      let e: AgentEvent
      try {
        e = JSON.parse(msg.data) as AgentEvent
      } catch {
        return
      }
      const cur = get().session
      if (e.type === 'session') {
        set({ session: e.session, mood: e.session.status === 'running' ? 'working' : get().mood })
        return
      }
      if (!cur || cur.id !== id) return
      if (e.type === 'ui') {
        const engine = get().canvasId === cur.canvasId ? useCanvas.getState().engine : null
        if (!engine) return
        if (e.action === 'select') engine.selection.set(e.ids)
        else engine.flyTo(e.ids)
        return
      }
      if (e.type === 'touch') {
        // 智能体刚改过的元素在画布上闪一下光晕
        if (get().canvasId !== cur.canvasId) return
        useCanvas.getState().engine?.flash(e.ids)
        set({ cursor: { ids: e.ids, at: Date.now() } })
        return
      }
      if (e.type === 'item') {
        const items = [...cur.items]
        const i = items.findIndex((x) => x.id === e.item.id)
        if (i >= 0) items[i] = e.item
        else items.push(e.item)
        set({ session: { ...cur, items, updatedAt: Date.now() } })
      } else if (e.type === 'status') {
        const wasRunning = cur.status === 'running'
        set({ session: { ...cur, status: e.status } })
        if (e.status === 'running') {
          clearTimeout(moodTimer)
          set({ mood: 'working' })
        } else if (wasRunning) {
          const failed = get().session?.items.at(-1)?.type === 'error'
          set({ mood: failed ? 'sad' : 'happy', unread: !get().open })
          clearTimeout(moodTimer)
          moodTimer = setTimeout(() => set({ mood: 'idle' }), 4000)
          void refreshList()
        }
      }
    }
  }

  const refreshList = async () => {
    const canvasId = get().canvasId
    if (!canvasId) return
    try {
      const sessions = await api.agentSessions(canvasId)
      if (get().canvasId === canvasId) set({ sessions })
    } catch {}
  }

  return {
    open: false,
    status: null,
    agent: savedAgent(),
    approval: savedApproval(),
    plan: savedFlag(PLAN_KEY),
    access: savedAccess(),
    canvasId: null,
    sessions: [],
    cursor: null,
    session: null,
    unread: false,
    mood: 'idle',
    error: null,
    focusSeq: 0,

    ask() {
      get().toggle(true)
      set({ focusSeq: get().focusSeq + 1 })
    },

    toggle(open) {
      const next = open ?? !get().open
      set({ open: next, ...(next ? { unread: false } : {}) })
      if (next && !get().status) void get().loadStatus()
    },

    async loadStatus(refresh = false) {
      try {
        const status = await api.agentStatus(refresh)
        set({ status })
        // 记住的智能体不可用时换成可用的那个（内置排在最前）
        const ok = status.agents.filter((a) => a.available)
        if (ok.length && !ok.some((a) => a.id === get().agent)) set({ agent: ok[0]!.id })
      } catch (err) {
        set({ error: (err as Error).message })
      }
    },

    setAgent(agent) {
      set({ agent })
      try {
        localStorage.setItem(AGENT_KEY, agent)
      } catch {}
    },

    setApproval(approval) {
      set({ approval })
      try {
        localStorage.setItem(APPROVAL_KEY, approval)
      } catch {}
    },

    setPlan(plan) {
      set({ plan })
      try {
        localStorage.setItem(PLAN_KEY, plan ? '1' : '0')
      } catch {}
    },

    setAccess(access) {
      set({ access })
      try {
        localStorage.setItem(ACCESS_KEY, access)
      } catch {}
    },

    async decide(approvalId, allow, scope) {
      const id = get().session?.id
      if (!id) return
      try {
        await api.decideAgentApproval(id, approvalId, allow, scope)
      } catch (err) {
        set({ error: (err as Error).message })
      }
    },

    async enter(canvasId) {
      if (canvasId === get().canvasId) return
      const mine = ++selectSeq
      connect(null)
      set({ canvasId, sessions: [], session: null, error: null, mood: 'idle' })
      if (!canvasId) return
      try {
        const sessions = await api.agentSessions(canvasId)
        if (mine !== selectSeq) return
        set({ sessions })
        if (sessions[0]) await get().select(sessions[0].id)
      } catch (err) {
        if (mine === selectSeq) set({ error: (err as Error).message })
      }
    },

    async select(id) {
      const mine = ++selectSeq
      const canvasId = get().canvasId
      try {
        const session = await api.agentSession(id)
        // 等应答期间换了画布或又点了别的会话
        if (mine !== selectSeq || get().canvasId !== canvasId) return
        set({ session, error: null, mood: session.status === 'running' ? 'working' : 'idle' })
        connect(id)
      } catch (err) {
        if (mine === selectSeq) set({ error: (err as Error).message })
      }
    },

    reset() {
      selectSeq++
      connect(null)
      set({ session: null, error: null, mood: 'idle' })
    },

    async send(text, selection) {
      const { canvasId, agent } = get()
      if (!canvasId) return
      set({ error: null })
      try {
        let session = get().session
        // 换了 CLI 就开新对话：两家的会话不能互相续
        if (!session || session.agent !== agent) {
          session = await api.createAgentSession(canvasId, agent)
          if (get().canvasId !== canvasId) return
          selectSeq++
          set({ session })
          connect(session.id)
        }
        await api.sendAgentMessage(session.id, text, selection, {
          approval: get().approval,
          plan: get().plan,
          access: get().access,
        })
        void refreshList()
      } catch (err) {
        set({ error: (err as Error).message, mood: 'sad' })
        clearTimeout(moodTimer)
        moodTimer = setTimeout(() => set({ mood: 'idle' }), 4000)
      }
    },

    async stop() {
      const id = get().session?.id
      if (id) await api.stopAgent(id).catch(() => {})
    },

    async undoTurn(turn) {
      const id = get().session?.id
      if (!id) return
      set({ error: null })
      try {
        await api.undoAgentTurn(id, turn)
      } catch (err) {
        set({ error: (err as Error).message })
      }
    },

    async remove(id) {
      try {
        await api.deleteAgentSession(id)
      } catch (err) {
        set({ error: (err as Error).message })
        return
      }
      if (get().session?.id === id) get().reset()
      set({ sessions: get().sessions.filter((s) => s.id !== id) })
    },
  }
})
