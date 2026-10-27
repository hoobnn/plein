import type {
  AgentAccess,
  AgentApprovalMode,
  AgentCli,
  AgentItem,
  AgentTurnSummary,
} from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { canvasBottomSpace } from '../../canvas/floatingPanel'
import { renderMarkdown } from '../../canvas/markdown'
import { useRoute } from '../../router'
import { EditPlanRow } from './EditPlanCard'
import { useAgent } from './store'
import { AgentControls } from './AgentControls'
import { AgentSkillsButton } from './AgentSkills'
import { AgentSelection } from './AgentSelection'
import { existingTargets, useAgentTargets } from './targets'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { shortTime } from '../../ui/format'
import { Icon } from '../../ui/icons'
import { Mascot } from '../../ui/Mascot'
import { Popover } from '../../ui/Popover'
import { Presence, useExit } from '../../ui/Presence'
import { Select } from '../../ui/Select'
import { BatchPlanDetails } from '../storyboard/BatchPlanDetails'

const TOOL_LABELS: Record<string, string> = {
  get_canvas: '查看画布',
  list_canvas_capabilities: '查询画布能力',
  list_canvas_actions: '查询扩展操作',
  perform_canvas_action: '执行扩展操作',
  get_sequence: '读取剪辑序列',
  edit_production: '编辑制作目标',
  edit_delivery_notes: '编辑交付反馈',
  list_canvas_templates: '读取工作流模板',
  place_canvas_template: '铺设工作流模板',
  extract_analysis_assets: '提取拉片素材',
  plan_analysis: '建立分析草稿',
  edit_sequence: '编辑剪辑实例',
  get_story_inputs: '读取原文来源',
  edit_story_state: '编辑来源与连续性',
  review_candidate: '记录审片意见',
  search_media: '检索已有素材',
  get_media_sources: '读取素材来源',
  list_jobs: '读取生成任务',
  recover_job: '恢复原任务',
  cancel_group: '取消整组运行',
  list_checkpoints: '读取检查点',
  create_checkpoint: '保存检查点',
  restore_checkpoint: '恢复检查点',
  delete_checkpoint: '删除检查点',
  capture_stage: '截取构图参考',
  get_canvas_page: '分页查看画布',
  get_element_field: '读取原文字段',
  get_element: '查看元素',
  inspect_node_input: '检查节点实际输入',
  reorder_inputs: '调整参考顺序',
  replace_input: '替换参考素材',
  find_elements: '查找元素',
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
  edit_media: '加工素材',
  run_flow: '运行上下游',
  run_frame: '整组运行',
  wait_for_group: '等待整组结果',
  list_stale: '检查过期结果',
  ui_get_selection: '查看选区',
  ui_get_viewport: '查看视口',
  ui_focus: '带你看',
  ui_select: '选中',
  await_approval: '等你确认',
  propose_plan: '列出计划',
  update_plan: '更新计划进度',
  propose_edit: '提出修改方案',
  apply_edit_plan: '执行修改方案',
  duplicate_elements: '复制',
  group_elements: '打组',
  ungroup: '解组',
  arrange_elements: '整理布局',
  reorder_elements: '调整层级',
  place_drama_template: '铺短剧模板',
  extract_cast: '生成设定卡',
  expand_storyboard: '展开分镜',
  sync_storyboard: '同步分镜',
  list_presets: '查看预设',
  apply_preset: '套用预设',
  rewrite_prompt: '改写提示词',
  run_storyboard: '批量运行分镜',
  search_library: '搜索资产库',
  place_library_item: '用到画布上',
  save_to_library: '存入资产库',
  WebSearch: '搜索',
  web_search: '搜索',
  WebFetch: '读取网页',
  shell: '执行命令',
}

const APPROVAL_OPTIONS: Array<{ value: AgentApprovalMode; label: string }> = [
  { value: 'rules', label: '视频、整组运行、删除前先问我' },
  { value: 'always', label: '每次运行和删除都先问我' },
  { value: 'auto', label: '不用问，直接做' },
]

const ACCESS_OPTIONS: Array<{ value: AgentAccess; label: string }> = [
  { value: 'auto', label: '本机操作先问我' },
  { value: 'full', label: '本机操作不用问' },
]

const SUGGESTIONS = [
  '用选中的角色参考图和配音，做一段 5 秒的视频',
  '看看这块画布，还缺哪些环节',
  '选中的视频节奏太慢，帮我调整一下',
]

/** 全局悬浮的吉祥物 + 助手面板：右下角，所有页面都在 */
export function AgentDock() {
  const route = useRoute()
  const ready = useSession((s) => s.status === 'ready' && !!s.info?.principal)
  const { open, mood, unread, toggle, enter } = useAgent(
    useShallow((s) => ({
      open: s.open,
      mood: s.mood,
      unread: s.unread,
      toggle: s.toggle,
      enter: s.enter,
    })),
  )
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    toggle(false)
    const target =
      trigger.current ?? document.querySelector<HTMLButtonElement>('[data-agent-trigger]')
    target?.focus()
  }, [toggle])
  const canvasId = route.name === 'canvas' ? route.id : null
  const engine = useCanvas((s) => s.engine)
  const mascotBottom = useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        const off = engine?.camera.onInsetsChange(notify)
        window.addEventListener('resize', notify)
        return () => {
          off?.()
          window.removeEventListener('resize', notify)
        }
      },
      [engine],
    ),
    () => canvasBottomSpace(window.innerWidth, engine?.camera.insets.left ?? 0).mascot,
  )

  useEffect(() => {
    if (ready) void enter(canvasId)
  }, [ready, canvasId, enter])

  // 节点编辑器固定在卡片下方，可能压住右下角的助手入口：
  // 入口被压住时先让开，编辑器里的生成按钮才点得到。
  useEffect(() => {
    if (!engine) return
    const sync = () => {
      const button = trigger.current
      if (!button) return
      const editor = document.querySelector('[data-testid="node-editor"]')
      if (!editor) {
        button.style.visibility = ''
        return
      }
      const a = button.getBoundingClientRect()
      const b = editor.getBoundingClientRect()
      // 用 visibility 收起：按钮还占着原来的位置，下次量到的还是同一块地方
      button.style.visibility =
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top ? 'hidden' : ''
    }
    const offs = [
      engine.onMove(sync),
      engine.onStateChange(sync),
      engine.selection.onChange(sync),
      engine.camera.onInsetsChange(sync),
    ]
    window.addEventListener('resize', sync)
    sync()
    return () => {
      for (const off of offs) off()
      window.removeEventListener('resize', sync)
    }
  }, [engine, ready])

  // Esc 关闭面板（输入框里的 Esc 也算）
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, close])

  if (!ready || route.name === 'demo') return null
  return (
    <>
      <Presence>
        {open && <AgentPanel canvasId={canvasId} onClose={close} bottom={mascotBottom + 76} />}
      </Presence>
      {route.name !== 'home' && (
        <button
          ref={trigger}
          type="button"
          onClick={() => toggle()}
          aria-label={open ? '收起助手' : '打开助手'}
          aria-expanded={open}
          title={open ? undefined : '小满：让本机的 Claude Code / Codex 帮你操作画布'}
          style={{ bottom: mascotBottom }}
          className="plein-mascot-btn pointer-events-auto fixed right-3 z-30 rounded-full"
        >
          <Mascot mood={mood} />
          {unread && (
            <span
              role="img"
              aria-label="助手有新回复"
              className="absolute top-1 right-1 size-2.5 rounded-full bg-accent ring-2 ring-canvas"
            />
          )}
        </button>
      )}
    </>
  )
}

function AgentPanel({
  canvasId,
  onClose,
  bottom,
}: {
  canvasId: string | null
  onClose(): void
  bottom: number
}) {
  const {
    status,
    agent,
    session,
    error,
    setAgent,
    loadStatus,
    loadingHistory,
    historyError,
    selectionError,
    selectionTitle,
    connectionError,
    reconnecting,
    selecting,
  } = useAgent(
    useShallow((s) => ({
      status: s.status,
      agent: s.agent,
      session: s.session,
      error: s.error,
      setAgent: s.setAgent,
      loadStatus: s.loadStatus,
      loadingHistory: s.loadingHistory,
      historyError: s.historyError,
      selectionError: s.selectionError,
      selectionTitle: s.sessions.find((item) => item.id === s.selectionError?.id)?.title,
      connectionError: s.connectionError,
      reconnecting: s.reconnecting,
      selecting: s.selecting,
    })),
  )
  const running = session?.status === 'running'
  const available = status?.agents.filter((a) => a.available) ?? []
  const current = session?.agent ?? agent
  const label = (a: AgentCli) => (a.model ? `${a.name} · ${a.model}` : a.name)
  const currentAgent = status?.agents.find((a) => a.id === current)
  const customModel = !!session?.settings?.model
  const cliName = currentAgent ? (customModel ? currentAgent.name : label(currentAgent)) : '小满'
  const intro =
    current === 'builtin'
      ? `我是小满，正在用${customModel ? '当前所选模型' : currentAgent?.model ? ` ${currentAgent.model} ` : '内置模型'}帮你操作这块画布。说说想做什么：`
      : `我是小满，会用你电脑上的 ${cliName} 来操作这块画布。说说想做什么：`
  const worker = current === 'builtin' ? '小满' : cliName
  const exit = useExit()

  return (
    <aside
      aria-label="助手"
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
        if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
      {...exit}
      style={{ bottom }}
      className="plein-agent-panel ui-float pointer-events-auto fixed top-16 right-3 z-40 flex w-100 flex-col overflow-hidden rounded-xl max-sm:inset-x-3 max-sm:w-auto"
    >
      <header className="flex h-12 flex-none items-center gap-1 border-b border-line pr-2 pl-4">
        <h2 className="mr-1 text-sm font-semibold">小满</h2>
        {available.length > 1 ? (
          <Select
            aria-label="使用的智能体"
            value={current}
            disabled={loadingHistory || !!selecting}
            options={available.map((a) => ({ value: a.id, label: label(a) }))}
            onChange={(v) => {
              setAgent(v as typeof agent)
              // 当前对话用的是另一个智能体：切换后从新对话开始
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
              disabled={!session && !historyError && !selectionError}
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
            onClick={onClose}
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
          <p>
            在 设置 → 默认模型
            里把对话模型设成支持工具调用的（如百炼的千问），就能直接用内置智能体。
          </p>
          <p className="mt-2">也可以安装并登录 Claude Code 或 Codex：</p>
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
          {loadingHistory ? (
            <div
              role="status"
              className="flex flex-1 items-center justify-center gap-2 px-4 text-xs text-ink-muted"
            >
              <span className="ui-spinner size-3" />
              正在读取历史对话…
            </div>
          ) : historyError || selectionError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs">
              <p role="alert" className="text-danger">
                {selectionError
                  ? `打开「${selectionTitle ?? '所选对话'}」失败：${selectionError.message}`
                  : `读取历史对话失败：${historyError}`}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={(e) => {
                    const input = e.currentTarget.closest('aside')?.querySelector('textarea')
                    if (selectionError) void useAgent.getState().select(selectionError.id)
                    else void useAgent.getState().enter(canvasId, true)
                    input?.focus()
                  }}
                >
                  重新读取
                </button>
                {selectionError && session && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-quiet ui-btn-sm"
                    onClick={(e) => {
                      const input = e.currentTarget.closest('aside')?.querySelector('textarea')
                      useAgent.getState().cancelSelection()
                      input?.focus()
                    }}
                  >
                    返回原对话
                  </button>
                )}
                <button
                  type="button"
                  className="ui-btn ui-btn-quiet ui-btn-sm"
                  onClick={(e) => {
                    const input = e.currentTarget.closest('aside')?.querySelector('textarea')
                    useAgent.getState().reset()
                    input?.focus()
                  }}
                >
                  开始新对话
                </button>
              </div>
            </div>
          ) : (
            <Transcript
              items={session?.items ?? []}
              running={running}
              intro={intro}
              worker={worker}
              lastTurn={session?.lastTurn}
            />
          )}
          {(connectionError || reconnecting) && (
            <div
              role={reconnecting ? 'status' : 'alert'}
              className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-muted"
            >
              <span className="min-w-0 flex-1">
                {reconnecting ? '正在重新连接对话…' : connectionError}
              </span>
              <button
                type="button"
                aria-label="重新连接"
                aria-busy={reconnecting}
                disabled={reconnecting || !!selecting}
                className="ui-btn ui-btn-secondary ui-btn-xs flex-none"
                onClick={(e) => {
                  const input = e.currentTarget.closest('aside')?.querySelector('textarea')
                  useAgent.getState().reconnect()
                  input?.focus()
                }}
              >
                {reconnecting ? '连接中…' : '重新连接'}
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="px-4 pb-2 text-xs text-danger">
              {error}
            </p>
          )}
          <Composer key={canvasId} canvasId={canvasId} running={running} />
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
  const { sessions, session, select, remove, removing } = useAgent(
    useShallow((s) => ({
      sessions: s.sessions,
      session: s.session,
      select: s.select,
      remove: s.remove,
      removing: s.removing,
    })),
  )
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!anchor || sessions.length) return
    setAnchor(null)
    if (anchor.isConnected) anchor.closest('aside')?.querySelector('textarea')?.focus()
  }, [anchor, sessions.length])
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
                    disabled={!!removing[s.id]}
                    aria-pressed={s.id === session?.id}
                    className="min-w-0 flex-1 px-2.5 py-2 text-left"
                    onClick={() => {
                      setAnchor(null)
                      void select(s.id)
                    }}
                  >
                    <span className="block truncate text-sm">{s.title}</span>
                    <span className="text-xs text-ink-subtle">
                      {s.agent === 'builtin'
                        ? '内置智能体'
                        : s.agent === 'codex'
                          ? 'Codex'
                          : 'Claude Code'}{' '}
                      · {shortTime(s.updatedAt)}
                      {s.status === 'running' && ' · 进行中'}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`删除对话：${s.title}`}
                    disabled={!!removing[s.id]}
                    aria-busy={!!removing[s.id]}
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

export function Transcript({
  items,
  running,
  intro,
  worker,
  lastTurn,
}: {
  items: AgentItem[]
  running: boolean
  /** 空对话时的开场白 */
  intro: string
  /** 「…正在处理」里的名字 */
  worker: string
  lastTurn?: AgentTurnSummary
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 停在底部时跟着新内容滚动；用户往上翻时不打扰
  // oxlint-disable react-hooks/exhaustive-deps -- 内容变化时触发滚动
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, running, lastTurn])
  // oxlint-enable react-hooks/exhaustive-deps

  if (items.length === 0) {
    return (
      // 面板铺满高度，开场白和建议贴着输入框，不悬在中间
      <div className="flex flex-1 flex-col justify-end gap-3 p-4">
        <p className="px-1 text-sm text-ink-muted">{intro}</p>
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
      role="region"
      aria-label="对话记录"
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 滚动阅读区需要接收原生翻页键。
      tabIndex={0}
      data-plein-scroll
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      className="ui-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3"
    >
      {items.map((it) =>
        // 计划进度直接画在计划卡片上，不再单列一行
        it.type === 'tool' && HIDDEN_TOOLS.has(it.name) ? null : <Item key={it.id} item={it} />,
      )}
      {running && (
        <div className="flex items-center gap-2 py-1 text-xs text-ink-subtle">
          <span className="ui-spinner size-3" />
          {worker} 正在处理…
        </div>
      )}
      {!running && lastTurn && <TurnStatusCard turn={lastTurn} />}
    </div>
  )
}

function TurnStatusCard({ turn }: { turn: AgentTurnSummary }) {
  if (turn.state !== 'stopped' && turn.state !== 'interrupted') return null
  const runs = new Set(turn.runs.map((run) => run.runId)).size
  const groups = new Set(turn.groups).size
  return (
    <div
      role="status"
      className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted"
    >
      <p className="font-medium text-ink">
        {turn.state === 'stopped' ? '本轮对话已停止' : '本轮对话被中断'}
      </p>
      <p className="mt-1">
        已完成的改动保留。
        {runs || groups
          ? `已提交 ${runs} 次节点运行、${groups} 组运行，状态以任务面板为准。`
          : '继续前会核对画布和已有任务。'}
      </p>
      <p className="mt-1">对话结束不代表生成任务失败，已提交的任务不会自动重发。</p>
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-sm mt-2"
        onClick={() => {
          useCanvas.getState().toggleTasks(true)
          useAgent.getState().toggle(false)
        }}
      >
        查看任务
      </button>
    </div>
  )
}

function Item({ item }: { item: AgentItem }) {
  if (item.type === 'user') {
    return (
      <div className="ml-10 self-end rounded-xl rounded-br-xs bg-surface-3 px-3 py-2 text-sm whitespace-pre-wrap">
        {item.text}
        {item.skill && (
          <span className="mt-1 block text-xs text-ink-subtle">技能：{item.skill.title}</span>
        )}
        {item.selection?.length ? (
          <div className="mt-1">
            <span className="mb-1 block text-xs text-ink-subtle">
              附带 {item.selection.length} 个选中元素
            </span>
            <AgentSelection ids={item.selection} />
          </div>
        ) : null}
      </div>
    )
  }
  if (item.type === 'text') return <Markdown text={item.text} />
  if (item.type === 'notice' || (item.type === 'error' && item.text === '已停止')) {
    return (
      <p
        role="status"
        className="rounded-md bg-surface-2 px-3 py-2 text-xs whitespace-pre-wrap text-ink-muted"
      >
        {item.text}
      </p>
    )
  }
  if (item.type === 'error') {
    return (
      <p className="rounded-md bg-danger-soft px-3 py-2 text-xs whitespace-pre-wrap text-danger">
        {item.text}
      </p>
    )
  }
  if (item.type === 'changes') return <ChangesRow item={item} />
  if (item.type === 'approval') return <ApprovalRow item={item} />
  if (item.type === 'plan') return <PlanRow item={item} />
  if (item.type === 'edit_plan') return <EditPlanRow item={item} />
  return <ToolRow item={item} />
}

const HIDDEN_TOOLS = new Set(['update_plan'])

const PLAN_STATUS: Record<string, string> = {
  pending: '小满想这样做',
  approved: '计划',
  denied: '计划没有采用',
  expired: '计划已过期',
}

/** 计划卡片：同意后小满按步骤执行，每一步做完打勾 */
function PlanRow({ item }: { item: Extract<AgentItem, { type: 'plan' }> }) {
  const busy = useAgent(
    (s) => !!s.pendingActions[`${s.session?.id}/decide/${item.id}`] || !!s.selecting,
  )
  const pending = item.status === 'pending'
  const done = item.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const decide = async (allow: boolean) => {
    await useAgent.getState().decide(item.id, allow)
  }

  return (
    <div
      className={`plein-agent-approval plein-agent-plan flex flex-col gap-2 rounded-lg px-3 py-2.5 text-xs ring-1 ring-inset ${pending ? 'bg-accent-soft/50 text-ink ring-accent/40' : 'text-ink ring-line'}`}
      data-status={item.status}
      aria-busy={busy}
    >
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon name="tasks" size={14} />
        <span className="min-w-0 flex-1 truncate">
          {PLAN_STATUS[item.status]}
          {item.summary ? `：${item.summary}` : ''}
        </span>
        {item.status === 'approved' && (
          <span className="flex-none tabular-nums text-ink-subtle">
            {done}/{item.steps.length}
          </span>
        )}
      </div>
      <ol className="flex flex-col gap-1.5">
        {item.steps.map((step, i) => (
          <li
            // oxlint-disable-next-line react/no-array-index-key -- 步骤按序号定位，不会重排
            key={i}
            className="plein-plan-step flex items-start gap-2"
            data-status={step.status}
            style={{ '--i': i } as React.CSSProperties}
          >
            <span className="plein-plan-mark mt-px flex size-4 flex-none items-center justify-center rounded-full">
              {step.status === 'doing' ? (
                <span className="ui-spinner size-3" />
              ) : step.status === 'done' ? (
                <Icon name="check" size={12} />
              ) : step.status === 'skipped' ? (
                <Icon name="x" size={12} />
              ) : (
                <span className="text-2xs tabular-nums">{i + 1}</span>
              )}
            </span>
            <span className="plein-plan-title min-w-0 flex-1 leading-5">{step.title}</span>
          </li>
        ))}
      </ol>
      {pending && (
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            className="ui-btn ui-btn-xs ui-btn-quiet"
            disabled={busy}
            onClick={() => void decide(false)}
          >
            不用了
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-xs ui-btn-primary"
            disabled={busy}
            onClick={() => void decide(true)}
          >
            同意并执行
          </button>
        </div>
      )}
    </div>
  )
}

const APPROVAL_DONE: Record<string, string> = {
  approved: '已允许',
  denied: '已跳过',
  expired: '已过期',
}

/** 等用户确认的操作：允许后服务端直接执行；悬停时在画布上高亮相关元素 */
function ApprovalRow({ item }: { item: Extract<AgentItem, { type: 'approval' }> }) {
  const { engine, ids } = useAgentTargets(item.ids)
  const busy = useAgent(
    (s) => !!s.pendingActions[`${s.session?.id}/decide/${item.id}`] || !!s.selecting,
  )
  const pending = item.status === 'pending'
  const decide = async (allow: boolean) => {
    await useAgent.getState().decide(item.id, allow)
  }

  return (
    <div
      className={`plein-agent-approval flex flex-col gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-inset ${pending ? 'bg-accent-soft/50 text-ink ring-accent/40' : 'text-ink-muted ring-line'}`}
      data-status={item.status}
      aria-busy={busy}
      onPointerEnter={() => {
        const live = existingTargets(engine?.doc, ids)
        if (live.length) engine?.flash(live)
      }}
    >
      <div className="flex items-center gap-2">
        <Icon name={pending ? 'warning' : item.status === 'approved' ? 'check' : 'x'} size={14} />
        <span className="min-w-0 flex-1">
          {pending ? '需要你确认：' : `${APPROVAL_DONE[item.status]}：`}
          {item.reason}
        </span>
        {ids.length > 0 && engine && (
          <button
            type="button"
            aria-label="在画布上查看"
            title="在画布上查看"
            className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
            onClick={() => {
              const live = existingTargets(engine.doc, ids)
              if (live.length) engine.flyTo(live)
            }}
          >
            <Icon name="locate" size={14} />
          </button>
        )}
      </div>
      {item.storyboardBatch && (
        <details>
          <summary className="cursor-pointer">审阅本次批量清单</summary>
          <div className="ui-scrollbar mt-2 max-h-96 overflow-auto">
            <BatchPlanDetails plan={item.storyboardBatch} />
          </div>
        </details>
      )}
      {pending && (
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            className="ui-btn ui-btn-xs ui-btn-quiet"
            disabled={busy}
            onClick={() => void decide(false)}
          >
            跳过
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-xs ui-btn-primary"
            disabled={busy}
            onClick={() => void decide(true)}
          >
            允许
          </button>
        </div>
      )}
    </div>
  )
}

/** 一轮对话的改动摘要：在画布上定位，或整轮撤销 */
function ChangesRow({ item }: { item: Extract<AgentItem, { type: 'changes' }> }) {
  const { engine, ids: shown } = useAgentTargets([...item.created, ...item.updated])
  const running = useAgent((s) => s.session?.status === 'running')
  const busy = useAgent((s) => !!s.pendingActions[`${s.session?.id}/undo/${item.turn}`])
  const selecting = useAgent((s) => !!s.selecting)
  const parts = [
    item.created.length && `新建 ${item.created.length}`,
    item.updated.length && `修改 ${item.updated.length}`,
    item.deleted.length && `删除 ${item.deleted.length}`,
    item.edges && `连线 ${item.edges}`,
    item.runs && `运行 ${item.runs}`,
  ].filter(Boolean)

  return (
    <div
      className={`plein-agent-changes flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-line ring-inset ${item.undone ? 'text-ink-subtle' : 'text-ink-muted'}`}
      onPointerEnter={() => {
        const live = existingTargets(engine?.doc, shown)
        if (!item.undone && live.length) engine?.flash(live)
      }}
    >
      <Icon name={item.undone ? 'undo' : 'sparkle'} size={14} />
      <span className={`min-w-0 flex-1 truncate ${item.undone ? 'line-through' : ''}`}>
        {item.undone ? '已撤销：' : '本轮：'}
        {parts.join(' · ') || '没有改动'}
        {item.undone && item.runs > 0 && ' · 已提交的任务和费用记录保留'}
      </span>
      {!item.undone && shown.length > 0 && engine && (
        <button
          type="button"
          aria-label="在画布上查看改动"
          title="在画布上查看改动"
          className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
          onClick={() => {
            const live = existingTargets(engine.doc, shown)
            if (!live.length) return
            engine.selection.set(live)
            engine.flyTo(live)
          }}
        >
          <Icon name="locate" size={14} />
        </button>
      )}
      {item.undoable && !item.undone && (
        <button
          type="button"
          className="ui-btn ui-btn-xs ui-btn-secondary"
          disabled={busy || running || selecting}
          aria-busy={busy}
          aria-label="撤销这一轮"
          title="撤销小满这一轮对画布的改动；之后你手动改过的地方会保留。已提交的生成任务和费用记录会保留，撤销不会退还平台费用"
          onClick={() => void useAgent.getState().undoTurn(item.turn)}
        >
          {busy ? '正在撤销…' : '撤销这一轮'}
        </button>
      )}
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  // oxlint-disable-next-line react/no-danger -- markdown-it 已关闭原始 HTML
  return <div className="plein-md plein-agent-md" dangerouslySetInnerHTML={{ __html: html }} />
}

/** 一次工具调用：一行摘要，点开看结果；涉及的元素可以定位 */
function ToolRow({ item }: { item: Extract<AgentItem, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const engine = useCanvas((s) => s.engine)
  const targetId = item.detail?.split(' · ')[0]
  const target = useSyncExternalStore(
    (notify) =>
      engine && targetId
        ? engine.doc.subscribe((change) => {
            if (change.elements.has(targetId)) notify()
          })
        : () => {},
    () => (targetId ? engine?.doc.get(targetId) : undefined),
  )
  const known = useRef<{ id: string; name: string } | null>(null)
  if (target) known.current = { id: target.id, name: target.name ?? target.kind }
  const detail = target
    ? (target.name ?? target.kind)
    : engine && known.current && known.current.id === targetId
      ? `${known.current.name}（已删除）`
      : item.detail
  // 插件能力的名字从插件来
  const { data: plugins } = useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: api.capabilities,
    staleTime: Number.POSITIVE_INFINITY,
    enabled: !(item.name in TOOL_LABELS),
  })
  const label =
    TOOL_LABELS[item.name] ?? plugins?.find((c) => c.name === item.name)?.title ?? item.name

  return (
    <div className="text-xs" data-tool-status={item.status}>
      <div className="flex items-center gap-2 text-ink-muted">
        <span className="flex size-4 flex-none items-center justify-center">
          {item.status === 'running' ? (
            <span className="ui-spinner size-3" />
          ) : item.status === 'stopped' ? (
            <span className="text-ink-subtle">
              <Icon name="stop" size={14} />
            </span>
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
              if (!engine.doc.get(target.id)) return
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

function Composer({ canvasId, running }: { canvasId: string; running: boolean }) {
  const text = useAgent((s) => s.drafts[canvasId]?.text ?? '')
  const sending = useAgent((s) => !!s.sending[canvasId])
  const selecting = useAgent((s) => !!s.selecting)
  const configuring = useAgent((s) => !!s.pendingActions[`${s.session?.id}/configure`])
  const historyBlocked = useAgent(
    (s) =>
      s.loadingHistory ||
      !!s.historyError ||
      !!s.selectionError ||
      !!s.connectionError ||
      s.reconnecting,
  )
  const stopping = useAgent((s) => !!s.pendingActions[`${s.session?.id}/stop`])
  const setText = (value: string) => useAgent.getState().setDraft(canvasId, value)
  const engine = useCanvas((s) => (s.canvasId === canvasId ? s.engine : null))
  const excluded = useAgent((s) => s.excludedSelections[canvasId])
  const subscribeSelection = useCallback(
    (notify: () => void) =>
      engine?.selection.onChange(() => {
        useAgent.getState().setExcludedSelection(canvasId)
        notify()
      }) ?? (() => {}),
    [engine, canvasId],
  )
  const selectionKey = useSyncExternalStore(subscribeSelection, () =>
    JSON.stringify(engine?.selection.values().sort() ?? []),
  )
  const withSelection = excluded !== selectionKey
  const selected = useCanvas((s) => s.selection)
  const excludedTargets = useAgent((s) => s.excludedTargets[canvasId])
  const selectedIds = (withSelection ? (JSON.parse(selectionKey) as string[]) : []).filter(
    (id) => excludedTargets?.signature !== selectionKey || !excludedTargets.ids.includes(id),
  )
  const skill = useAgent((s) => s.selectedSkills[canvasId])
  const agent = useAgent((s) => s.session?.agent ?? s.agent)
  const approval = useAgent((s) => s.approval)
  const plan = useAgent((s) => s.plan)
  const access = useAgent((s) => s.access)
  const local = useAgent((s) => (s.session?.agent ?? s.agent) !== 'builtin')
  const focusSeq = useAgent((s) => s.focusSeq)
  const ref = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)

  // 打开时、点「让小满处理」时把光标放进输入框
  // oxlint-disable react-hooks/exhaustive-deps -- focusSeq 变化即重新聚焦
  useEffect(() => {
    ref.current?.focus()
  }, [focusSeq])
  // oxlint-enable react-hooks/exhaustive-deps
  // 同数量更换目标也属于新选区；Selection 不为相同集合的顺序变化发事件。
  useEffect(() => {
    if (!engine || useCanvas.getState().engine !== engine) return
    const reset = () => useAgent.getState().setExcludedSelection(canvasId)
    const stored = useAgent.getState().excludedSelections[canvasId]
    if (stored !== undefined && stored !== JSON.stringify(engine?.selection.values().sort() ?? []))
      reset()
  }, [engine, canvasId])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const submit = () => {
    const t = text.trim()
    if (!t || running || sending || selecting || configuring || historyBlocked) return
    void useAgent.getState().send(t, selectedIds.length ? selectedIds : undefined)
  }

  return (
    <div className="border-t border-line p-3">
      <AgentControls
        disabled={running || sending || selecting || configuring || historyBlocked}
        selectionCount={selectedIds.length}
      />
      {skill && (
        <div className="mb-2 flex">
          <span className="ui-chip max-w-full pr-0.5">
            <Icon name="sparkle" size={12} />
            <span className="truncate">
              技能：{skill.title}
              {skill.source === 'codex' && agent !== 'codex' ? '（仅 Codex）' : ''}
            </span>
            <button
              type="button"
              className="ui-chip-remove"
              aria-label="移除本轮技能"
              onClick={() => useAgent.getState().clearSkill(canvasId)}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        </div>
      )}
      {selected > 0 && withSelection && selectedIds.length > 0 && (
        <div className="mb-2 flex flex-col items-start gap-1.5">
          <span className="ui-chip pr-0.5">
            <Icon name="cursor" size={12} />
            带上选中的 {selectedIds.length} 个元素
            <button
              type="button"
              aria-label="不带选中元素"
              title="不带选中元素"
              className="ui-chip-remove"
              onClick={() => useAgent.getState().setExcludedSelection(canvasId, selectionKey)}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
          <AgentSelection ids={selectedIds} canvasId={canvasId} signature={selectionKey} />
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder="让小满帮你做点什么…"
          className="ui-input ui-input-lg ui-scrollbar max-h-40 min-h-9 flex-1 resize-none"
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onBlur={() => {
            composing.current = false
          }}
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
              // 保留输入法默认行为，阻止画布快捷键把输入框失焦。
              e.stopPropagation()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button
            type="button"
            aria-label="停止"
            aria-busy={stopping}
            disabled={stopping || selecting}
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
            disabled={!text.trim() || sending || selecting || configuring || historyBlocked}
            aria-busy={sending}
            onClick={submit}
          >
            <Icon name="arrowUp" size={16} />
          </button>
        )}
      </div>
      {sending && (
        <p role="status" className="mt-2 text-xs text-ink-subtle">
          正在发送…
        </p>
      )}
      {stopping && (
        <p role="status" className="mt-2 text-xs text-ink-subtle">
          正在停止…
        </p>
      )}
      {selecting && (
        <p role="status" className="mt-2 text-xs text-ink-subtle">
          正在打开对话…
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <AgentSkillsButton
          canvasId={canvasId}
          selectionCount={selectedIds.length}
          disabled={running || sending || selecting || configuring || historyBlocked}
        />
        <button
          type="button"
          aria-pressed={plan}
          title="先列出计划，你同意后小满再动手"
          className={`ui-btn ui-btn-xs ui-btn-quiet h-6 gap-1 px-1.5 text-2xs ${plan ? 'text-accent' : 'text-ink-subtle'}`}
          onClick={() => useAgent.getState().setPlan(!plan)}
        >
          <Icon name="tasks" size={12} />
          先出计划
        </button>
        <Select
          aria-label="确认方式"
          value={approval}
          options={APPROVAL_OPTIONS}
          onChange={(v) => useAgent.getState().setApproval(v as AgentApprovalMode)}
          className="h-6 text-2xs text-ink-subtle"
        />
        {local && (
          <Select
            aria-label="本机权限"
            value={access}
            options={ACCESS_OPTIONS}
            onChange={(v) => useAgent.getState().setAccess(v as AgentAccess)}
            className={`h-6 text-2xs ${access === 'full' ? 'text-warning' : 'text-ink-subtle'}`}
          />
        )}
      </div>
    </div>
  )
}
