import type { AgentItem } from '@plein/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../canvas/markdown'
import { useRoute } from '../router'
import { useAgent } from '../stores/agent'
import { useCanvas } from '../stores/canvas'
import { useSession } from '../stores/session'
import { shortTime } from '../ui/format'
import { Icon } from '../ui/icons'
import { Mascot } from '../ui/Mascot'
import { Popover } from '../ui/Popover'
import { Presence, useExit } from '../ui/Presence'
import { Select } from '../ui/Select'

const TOOL_LABELS: Record<string, string> = {
  get_canvas: '查看画布',
  get_element: '查看元素',
  list_node_types: '查看可用节点',
  create_node: '新建节点',
  create_element: '新建元素',
  update_element: '修改',
  connect: '连线',
  disconnect: '断开连线',
  delete_elements: '删除',
  run_node: '运行节点',
  wait_for_run: '等待结果',
  cancel_run: '取消运行',
  adopt_result: '采用结果',
  view_media: '查看效果',
  edit_video: '剪辑视频',
  WebSearch: '搜索',
  web_search: '搜索',
  WebFetch: '读取网页',
  shell: '执行命令',
}

const SUGGESTIONS = [
  '用选中的角色参考图和配音，做一段 5 秒的视频',
  '看看这块画布，还缺哪些环节',
  '选中的视频节奏太慢，帮我调整一下',
]

/** 全局悬浮的吉祥物 + 助手面板：右下角，所有页面都在 */
export function AgentDock() {
  const route = useRoute()
  const ready = useSession((s) => s.status === 'ready' && !!s.info?.principal)
  const { open, mood, unread, toggle, enter } = useAgent()
  const canvasId = route.name === 'canvas' ? route.id : null

  useEffect(() => {
    if (ready) void enter(canvasId)
  }, [ready, canvasId, enter])

  // Esc 关闭面板（输入框里的 Esc 也算）
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) toggle(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, toggle])

  if (!ready || route.name === 'demo') return null
  return (
    <>
      <Presence>{open && <AgentPanel canvasId={canvasId} />}</Presence>
      <button
        type="button"
        onClick={() => toggle()}
        aria-label={open ? '收起助手' : '打开助手'}
        aria-expanded={open}
        title={open ? undefined : '小满：让本机的 Claude Code / Codex 帮你操作画布'}
        className="plein-mascot-btn pointer-events-auto fixed right-3 bottom-2 z-40 rounded-full max-sm:bottom-16"
      >
        <Mascot mood={mood} />
        {unread && (
          <span className="absolute top-1 right-1 size-2.5 rounded-full bg-accent ring-2 ring-canvas" />
        )}
      </button>
    </>
  )
}

function AgentPanel({ canvasId }: { canvasId: string | null }) {
  const { status, agent, session, error, setAgent, loadStatus, toggle } = useAgent()
  const running = session?.status === 'running'
  const available = status?.agents.filter((a) => a.available) ?? []
  const current = session?.agent ?? agent
  const cliName = status?.agents.find((a) => a.id === current)?.name ?? 'Claude Code'
  const exit = useExit()

  return (
    <aside
      aria-label="助手"
      {...exit}
      className="plein-agent-panel ui-float pointer-events-auto fixed right-3 bottom-19 z-40 flex h-[min(640px,calc(100vh-150px))] w-100 flex-col overflow-hidden rounded-xl max-sm:inset-x-3 max-sm:bottom-33 max-sm:w-auto"
    >
      <header className="flex h-12 flex-none items-center gap-1 border-b border-line pr-2 pl-4">
        <h2 className="mr-1 text-sm font-semibold">小满</h2>
        {available.length > 1 ? (
          <Select
            aria-label="使用的智能体"
            value={current}
            options={available.map((a) => ({ value: a.id, label: a.name }))}
            onChange={(v) => {
              setAgent(v as typeof agent)
              // 当前对话用的是另一家 CLI：切换后从新对话开始
              if (session && session.agent !== v) useAgent.getState().reset()
            }}
            className="h-7 text-xs"
          />
        ) : (
          available.length === 1 && <span className="text-xs text-ink-subtle">{cliName}</span>
        )}
        <div className="ml-auto flex items-center">
          {canvasId && <SessionMenu />}
          {canvasId && (
            <button
              type="button"
              aria-label="新对话"
              title="新对话"
              className="ui-btn ui-btn-quiet ui-icon-btn"
              disabled={!session}
              onClick={() => useAgent.getState().reset()}
            >
              <Icon name="plus" />
            </button>
          )}
          <button
            type="button"
            aria-label="关闭"
            title="关闭（Esc）"
            className="ui-btn ui-btn-quiet ui-icon-btn"
            onClick={() => toggle(false)}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>

      {!status ? (
        <Notice>{error ? `读取助手状态失败：${error}` : '加载中…'}</Notice>
      ) : !status.enabled ? (
        <Notice>{status.reason}</Notice>
      ) : available.length === 0 ? (
        <Notice>
          <p>没有在这台电脑上找到 Claude Code 或 Codex。安装并登录其中一个后再试：</p>
          <pre className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-left text-xs text-ink">
            {'npm i -g @anthropic-ai/claude-code\nnpm i -g @openai/codex'}
          </pre>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm mt-3"
            onClick={() => void loadStatus(true)}
          >
            重新检测
          </button>
        </Notice>
      ) : !canvasId ? (
        <Notice>打开一块画布，我就能帮你搭工作流、生成素材，或者修改不满意的片段。</Notice>
      ) : (
        <>
          <Transcript items={session?.items ?? []} running={running} cliName={cliName} />
          {error && <p className="px-4 pb-2 text-xs text-danger">{error}</p>}
          <Composer running={running} />
        </>
      )}
    </aside>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center text-sm text-ink-muted">
      {children}
    </div>
  )
}

/** 历史对话 */
function SessionMenu() {
  const { sessions, session, select, remove } = useAgent()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  return (
    <>
      <button
        type="button"
        aria-label="历史对话"
        title="历史对话"
        aria-expanded={!!anchor}
        className="ui-btn ui-btn-quiet ui-icon-btn"
        disabled={sessions.length === 0}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <Icon name="history" />
      </button>
      <Presence>
        {anchor && (
          <Popover
            anchor={anchor}
            onClose={() => setAnchor(null)}
            label="历史对话"
            placement="below"
            width={280}
          >
            <div className="ui-scrollbar max-h-80 overflow-y-auto p-1">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center rounded-md hover:bg-hover ${s.id === session?.id ? 'bg-active' : ''}`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-2.5 py-2 text-left"
                    onClick={() => {
                      setAnchor(null)
                      void select(s.id)
                    }}
                  >
                    <span className="block truncate text-sm">{s.title}</span>
                    <span className="text-xs text-ink-subtle">
                      {s.agent === 'codex' ? 'Codex' : 'Claude Code'} · {shortTime(s.updatedAt)}
                      {s.status === 'running' && ' · 进行中'}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="删除对话"
                    title="删除对话"
                    className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => void remove(s.id)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}

function Transcript({
  items,
  running,
  cliName,
}: {
  items: AgentItem[]
  running: boolean
  cliName: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 停在底部时跟着新内容滚动；用户往上翻时不打扰
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变化时触发滚动
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, running])

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-ink-muted">
          我是小满，会用你电脑上的 {cliName} 来操作这块画布。说说想做什么：
        </p>
        <div className="flex w-full flex-col gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="rounded-md px-3 py-2 text-left text-sm text-ink-muted ring-1 ring-line transition-colors ring-inset hover:bg-hover hover:text-ink"
              onClick={() =>
                useAgent.getState().send(s, useCanvas.getState().engine?.selection.values())
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      className="ui-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3"
    >
      {items.map((it) => (
        <Item key={it.id} item={it} />
      ))}
      {running && (
        <div className="flex items-center gap-2 py-1 text-xs text-ink-subtle">
          <span className="ui-spinner size-3" />
          {cliName} 正在处理…
        </div>
      )}
    </div>
  )
}

function Item({ item }: { item: AgentItem }) {
  if (item.type === 'user') {
    return (
      <div className="ml-10 self-end rounded-xl rounded-br-xs bg-surface-3 px-3 py-2 text-sm whitespace-pre-wrap">
        {item.text}
        {item.selection?.length ? (
          <span className="mt-1 block text-xs text-ink-subtle">
            附带 {item.selection.length} 个选中元素
          </span>
        ) : null}
      </div>
    )
  }
  if (item.type === 'text') return <Markdown text={item.text} />
  if (item.type === 'error') {
    return (
      <p className="rounded-md bg-danger-soft px-3 py-2 text-xs whitespace-pre-wrap text-danger">
        {item.text}
      </p>
    )
  }
  return <ToolRow item={item} />
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it 已关闭原始 HTML
  return <div className="plein-md plein-agent-md" dangerouslySetInnerHTML={{ __html: html }} />
}

/** 一次工具调用：一行摘要，点开看结果；涉及的元素可以定位 */
function ToolRow({ item }: { item: Extract<AgentItem, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const engine = useCanvas((s) => s.engine)
  const target = item.detail && engine?.doc.get(item.detail.split(' · ')[0]!)
  const detail = target ? (target.name ?? target.kind) : item.detail
  const label = TOOL_LABELS[item.name] ?? item.name

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 text-ink-muted">
        <span className="flex size-4 flex-none items-center justify-center">
          {item.status === 'running' ? (
            <span className="ui-spinner size-3" />
          ) : item.status === 'error' ? (
            <span className="text-danger">
              <Icon name="x" size={14} />
            </span>
          ) : (
            <span className="text-ink-subtle">
              <Icon name="check" size={14} />
            </span>
          )}
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-ink"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          disabled={!item.output}
        >
          <span className="flex-none font-medium">{label}</span>
          {detail && <span className="truncate text-ink-subtle">{detail}</span>}
        </button>
        {target && engine && (
          <button
            type="button"
            aria-label="在画布上定位"
            title="在画布上定位"
            className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
            onClick={() => {
              engine.selection.set([target.id])
              engine.zoomToFit([target.id])
            }}
          >
            <Icon name="locate" size={14} />
          </button>
        )}
      </div>
      {open && item.output && (
        <pre className="ui-scrollbar mt-1 ml-6 max-h-48 overflow-auto rounded-md bg-surface-2 px-2.5 py-2 text-2xs whitespace-pre-wrap text-ink-muted">
          {item.output}
        </pre>
      )}
    </div>
  )
}

function Composer({ running }: { running: boolean }) {
  const [text, setText] = useState('')
  const [withSelection, setWithSelection] = useState(true)
  const selected = useCanvas((s) => s.selection)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])
  // 选区变了就默认重新带上
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选区数量变化时重置
  useEffect(() => setWithSelection(true), [selected])

  const submit = () => {
    const t = text.trim()
    if (!t || running) return
    const sel = withSelection ? useCanvas.getState().engine?.selection.values() : undefined
    setText('')
    void useAgent.getState().send(t, sel?.length ? sel : undefined)
  }

  return (
    <div className="border-t border-line p-3">
      {selected > 0 && withSelection && (
        <div className="mb-2 flex">
          <span className="ui-chip pr-0.5">
            <Icon name="cursor" size={12} />
            带上选中的 {selected} 个元素
            <button
              type="button"
              aria-label="不带选中元素"
              title="不带选中元素"
              className="flex size-5 items-center justify-center rounded-xs text-ink-subtle transition-colors hover:bg-active hover:text-ink"
              onClick={() => setWithSelection(false)}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder="让小满帮你做点什么…"
          className="ui-input ui-input-lg ui-scrollbar max-h-40 min-h-9 flex-1 resize-none"
          onChange={(e) => {
            setText(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${el.scrollHeight}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button
            type="button"
            aria-label="停止"
            title="停止"
            className="ui-btn ui-btn-lg ui-btn-secondary ui-icon-btn"
            onClick={() => void useAgent.getState().stop()}
          >
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="发送"
            title="发送（Enter）"
            className="ui-btn ui-btn-lg ui-btn-primary ui-icon-btn"
            disabled={!text.trim()}
            onClick={submit}
          >
            <Icon name="arrowUp" size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
