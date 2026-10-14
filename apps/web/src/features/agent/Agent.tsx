import type {
  AgentAccess,
  AgentApprovalMode,
  AgentCli,
  AgentItem,
  EditEstimate,
  EditScope,
  EditStage,
} from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { renderMarkdown } from '../../canvas/markdown'
import { useRoute } from '../../router'
import { useAgent } from './store'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { shortTime } from '../../ui/format'
import { Icon } from '../../ui/icons'
import { Mascot } from '../../ui/Mascot'
import { Popover } from '../../ui/Popover'
import { Presence, useExit } from '../../ui/Presence'
import { Select } from '../../ui/Select'

const TOOL_LABELS: Record<string, string> = {
  get_canvas: '查看画布',
  get_element: '查看元素',
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
  const { open, mood, unread, toggle, enter } = useAgent()
  const canvasId = route.name === 'canvas' ? route.id : null

  useEffect(() => {
    if (ready) void enter(canvasId)
  }, [ready, canvasId, enter])

  // 面板浮在画布右侧：告诉相机右边被挡住多少，小满带你看结果时不会落在面板下面
  const engine = useCanvas((s) => s.engine)
  useEffect(() => {
    if (!engine) return
    engine.camera.setInsets({ right: open && window.innerWidth >= 640 ? 424 : 0 })
    return () => engine.camera.setInsets({ right: 0 })
  }, [engine, open])

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
  const label = (a: AgentCli) => (a.model ? `${a.name} · ${a.model}` : a.name)
  const currentAgent = status?.agents.find((a) => a.id === current)
  const cliName = currentAgent ? label(currentAgent) : '小满'
  const intro =
    current === 'builtin'
      ? `我是小满，正在用${currentAgent?.model ? ` ${currentAgent.model} ` : '内置模型'}帮你操作这块画布。说说想做什么：`
      : `我是小满，会用你电脑上的 ${cliName} 来操作这块画布。说说想做什么：`
  const worker = current === 'builtin' ? '小满' : cliName
  const exit = useExit()

  return (
    <aside
      aria-label="助手"
      {...exit}
      className="plein-agent-panel ui-float pointer-events-auto fixed top-16 right-3 bottom-21 z-40 flex w-100 flex-col overflow-hidden rounded-xl max-sm:inset-x-3 max-sm:bottom-35 max-sm:w-auto"
    >
      <header className="flex h-12 flex-none items-center gap-1 border-b border-line pr-2 pl-4">
        <h2 className="mr-1 text-sm font-semibold">小满</h2>
        {available.length > 1 ? (
          <Select
            aria-label="使用的智能体"
            value={current}
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
          <Transcript
            items={session?.items ?? []}
            running={running}
            intro={intro}
            worker={worker}
          />
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
  intro,
  worker,
}: {
  items: AgentItem[]
  running: boolean
  /** 空对话时的开场白 */
  intro: string
  /** 「…正在处理」里的名字 */
  worker: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 停在底部时跟着新内容滚动；用户往上翻时不打扰
  // oxlint-disable react-hooks/exhaustive-deps -- 内容变化时触发滚动
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, running])
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
  const [busy, setBusy] = useState(false)
  const pending = item.status === 'pending'
  const done = item.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const decide = async (allow: boolean) => {
    setBusy(true)
    await useAgent.getState().decide(item.id, allow)
    setBusy(false)
  }

  return (
    <div
      className={`plein-agent-approval plein-agent-plan flex flex-col gap-2 rounded-lg px-3 py-2.5 text-xs ring-1 ring-inset ${pending ? 'bg-accent-soft/50 text-ink ring-accent/40' : 'text-ink ring-line'}`}
      data-status={item.status}
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

const STAGE_LABELS: Record<EditStage, string> = {
  image: '镜头图',
  video: '视频',
  speech: '配音',
  other: '其他',
}

const SCOPE_LABELS: Record<EditScope, string> = {
  text: '只改文字',
  images: '只出候选图',
  full: '完整方案',
}

/** 某个批准范围的调用与费用；缺价格时标明未知 */
function costText(e: EditEstimate) {
  const reuse = e.cached ? `，沿用 ${e.cached} 个已有候选` : ''
  if (!e.calls) return `不调用平台${reuse}`
  const price = e.cost.currency
    ? `约 ${Number(e.cost.amount.toFixed(2))} ${e.cost.currency}${e.cost.unknown ? `，${e.cost.unknown} 次价格未知` : ''}`
    : '价格未知'
  return `调用平台 ${e.calls} 次 · ${price}${reuse}`
}

const show = (v: unknown) =>
  v === undefined || v === '' ? '（空）' : typeof v === 'string' ? v : JSON.stringify(v)

const shotOf = (s: { shot?: { no?: number } }) => (s.shot?.no ? `第 ${s.shot.no} 镜 · ` : '')

/** 按阶段数：镜头图 ×1 · 视频 ×1 */
function stageCounts(steps: Array<{ stage: EditStage }>) {
  const n = new Map<EditStage, number>()
  for (const s of steps) n.set(s.stage, (n.get(s.stage) ?? 0) + 1)
  return [...n].map(([stage, count]) => `${STAGE_LABELS[stage]} ×${count}`).join(' · ')
}

/**
 * 修改方案卡片：要改的字段（前后值）、改完后实际送的参考、会运行的节点和保留项，
 * 用户按范围批准：只改文字 / 只出候选图 / 完整方案
 */
function EditPlanRow({ item }: { item: Extract<AgentItem, { type: 'edit_plan' }> }) {
  const engine = useCanvas((s) => s.engine)
  const [busy, setBusy] = useState(false)
  const { plan } = item
  const pending = item.status === 'pending' && plan.status === 'pending'
  const ids = plan.targets.map((t) => t.nodeId).filter((id) => engine?.doc.get(id))
  const decide = async (allow: boolean, scope?: EditScope) => {
    setBusy(true)
    await useAgent.getState().decide(item.id, allow, scope)
    setBusy(false)
  }
  const images = plan.steps.filter((s) => s.scope === 'images')
  const fullOnly = plan.steps.filter((s) => s.scope === 'full')
  const name = (id: string) =>
    plan.targets.find((t) => t.nodeId === id)?.name ??
    plan.steps.find((s) => s.nodeId === id)?.name ??
    id
  const status =
    plan.status === 'applied' && plan.applied
      ? `已执行${SCOPE_LABELS[plan.applied.scope]}${plan.applied.nodes.length ? `，运行 ${plan.applied.nodes.length} 个节点` : '，没有调用平台'}`
      : plan.status === 'stale'
        ? '目标在批准前变了，旧方案没有执行'
        : item.status === 'denied' || plan.status === 'denied'
          ? '方案没有采用'
          : item.status === 'expired' || plan.status === 'expired'
            ? '方案已过期'
            : item.status === 'approved'
              ? `正在执行${item.scope ? SCOPE_LABELS[item.scope] : ''}`
              : '小满的修改方案'

  return (
    <div
      className={`plein-agent-approval plein-edit-plan flex flex-col gap-2 rounded-lg px-3 py-2.5 text-xs ring-1 ring-inset ${pending ? 'bg-accent-soft/50 text-ink ring-accent/40' : 'text-ink ring-line'}`}
      data-status={plan.status}
      onPointerEnter={() => {
        if (ids.length) engine?.flash(ids)
      }}
    >
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon
          name={plan.status === 'stale' ? 'warning' : plan.status === 'applied' ? 'check' : 'wand'}
          size={14}
        />
        <span className="min-w-0 flex-1 truncate">
          {status}：{plan.summary}
        </span>
        {ids.length > 0 && engine && (
          <button
            type="button"
            aria-label="在画布上查看"
            title="在画布上查看"
            className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
            onClick={() => engine.flyTo(ids)}
          >
            <Icon name="locate" size={14} />
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {plan.targets.map((t) => (
          <li key={t.nodeId} className="flex flex-col gap-1">
            <span className="font-medium">
              {shotOf(t)}
              {t.name}
            </span>
            {t.changes.map((c) => (
              <div key={c.key} className="flex flex-col gap-0.5 leading-4">
                <span className="text-ink-subtle">{c.label}</span>
                <span className="line-clamp-2 break-words text-ink-subtle line-through">
                  {show(c.before)}
                </span>
                <span className="line-clamp-3 break-words">{show(c.after)}</span>
              </div>
            ))}
            {t.refs.length > 0 && (
              <span className="text-ink-subtle">
                参考：
                {t.refs
                  .map((r) => `${r.name}${r.sent.length ? ` ${r.sent.length} 张` : '（只附文字）'}`)
                  .join('、')}
              </span>
            )}
            {t.issues.map((i) => (
              <span key={i.code + (i.elementId ?? '')} className="text-warning">
                {i.message}
              </span>
            ))}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-muted">
        {images.length > 0 && (
          <>
            <dt className="text-ink-subtle">出候选图</dt>
            <dd>{images.map((s) => `${shotOf(s)}${s.name}`).join('、')}</dd>
          </>
        )}
        {fullOnly.length > 0 && (
          <>
            <dt className="text-ink-subtle">完整方案还会</dt>
            <dd>{stageCounts(fullOnly)}</dd>
          </>
        )}
        {(plan.keep.length > 0 || plan.untouched > 0) && (
          <>
            <dt className="text-ink-subtle">保留</dt>
            <dd>
              {[
                ...plan.keep.map((k) => `${shotOf(k)}${k.name}`),
                ...(plan.untouched ? [`其余 ${plan.untouched} 个结果不受影响`] : []),
              ].join('、')}
            </dd>
          </>
        )}
        {plan.status === 'stale' && plan.changed && (
          <>
            <dt className="text-ink-subtle">变了的</dt>
            <dd>{plan.changed.map(name).join('、')}，让小满重新检查</dd>
          </>
        )}
      </dl>
      {pending && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface-2 px-2 py-1.5 text-ink-muted">
            {(['text', 'images', 'full'] as const).map((scope) => (
              <div key={scope} className="contents">
                <dt className="text-ink-subtle">{SCOPE_LABELS[scope]}</dt>
                <dd className="tabular-nums">{costText(plan.estimate[scope])}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap justify-end gap-1.5">
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
              className="ui-btn ui-btn-xs ui-btn-secondary"
              disabled={busy}
              title="只把文字改动写进画布，不调用平台"
              onClick={() => void decide(true, 'text')}
            >
              只改文字
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-xs ui-btn-secondary"
              disabled={busy || images.length === 0}
              title={costText(plan.estimate.images)}
              onClick={() => void decide(true, 'images')}
            >
              只出候选图
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-xs ui-btn-primary"
              disabled={busy}
              title={costText(plan.estimate.full)}
              onClick={() => void decide(true, 'full')}
            >
              执行完整方案
            </button>
          </div>
        </>
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
  const engine = useCanvas((s) => s.engine)
  const [busy, setBusy] = useState(false)
  const pending = item.status === 'pending'
  const ids = item.ids.filter((id) => engine?.doc.get(id))
  const decide = async (allow: boolean) => {
    setBusy(true)
    await useAgent.getState().decide(item.id, allow)
    setBusy(false)
  }

  return (
    <div
      className={`plein-agent-approval flex flex-col gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-inset ${pending ? 'bg-accent-soft/50 text-ink ring-accent/40' : 'text-ink-muted ring-line'}`}
      data-status={item.status}
      onPointerEnter={() => {
        if (ids.length) engine?.flash(ids)
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
            onClick={() => engine.flyTo(ids)}
          >
            <Icon name="locate" size={14} />
          </button>
        )}
      </div>
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
  const engine = useCanvas((s) => s.engine)
  const running = useAgent((s) => s.session?.status === 'running')
  const [busy, setBusy] = useState(false)
  const parts = [
    item.created.length && `新建 ${item.created.length}`,
    item.updated.length && `修改 ${item.updated.length}`,
    item.deleted.length && `删除 ${item.deleted.length}`,
    item.edges && `连线 ${item.edges}`,
    item.runs && `运行 ${item.runs}`,
  ].filter(Boolean)
  const shown = [...item.created, ...item.updated].filter((id) => engine?.doc.get(id))

  return (
    <div
      className={`plein-agent-changes flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-line ring-inset ${item.undone ? 'text-ink-subtle' : 'text-ink-muted'}`}
      onPointerEnter={() => {
        if (!item.undone && shown.length) engine?.flash(shown)
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
            engine.selection.set(shown)
            engine.flyTo(shown)
          }}
        >
          <Icon name="locate" size={14} />
        </button>
      )}
      {item.undoable && !item.undone && (
        <button
          type="button"
          className="ui-btn ui-btn-xs ui-btn-secondary"
          disabled={busy || running}
          title="撤销小满这一轮对画布的改动；之后你手动改过的地方会保留。已提交的生成任务和费用记录会保留，撤销不会退还平台费用"
          onClick={async () => {
            setBusy(true)
            await useAgent.getState().undoTurn(item.turn)
            setBusy(false)
          }}
        >
          撤销这一轮
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
  const target = item.detail && engine?.doc.get(item.detail.split(' · ')[0]!)
  const detail = target ? (target.name ?? target.kind) : item.detail
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
  const approval = useAgent((s) => s.approval)
  const plan = useAgent((s) => s.plan)
  const access = useAgent((s) => s.access)
  const local = useAgent((s) => (s.session?.agent ?? s.agent) !== 'builtin')
  const focusSeq = useAgent((s) => s.focusSeq)
  const ref = useRef<HTMLTextAreaElement>(null)

  // 打开时、点「让小满处理」时把光标放进输入框
  // oxlint-disable react-hooks/exhaustive-deps -- focusSeq 变化即重新聚焦
  useEffect(() => {
    ref.current?.focus()
  }, [focusSeq])
  // oxlint-enable react-hooks/exhaustive-deps
  // 选区变了就默认重新带上
  // oxlint-disable react-hooks/exhaustive-deps -- 选区数量变化时重置
  useEffect(() => setWithSelection(true), [selected])
  // oxlint-enable react-hooks/exhaustive-deps

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
              className="ui-chip-remove"
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
      <div className="mt-2 flex items-center gap-1">
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
