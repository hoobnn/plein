import type { AgentContext, AgentSettings } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../api/client'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { AnimatePresence } from '../../ui/motion'
import { Select } from '../../ui/Select'
import { useAgent } from './store'

const EFFORT_LABELS: Record<string, string> = {
  none: '不推理',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '超高',
}

const number = (n: number) => n.toLocaleString('zh-CN')

/** 缺省（不写 compactAt）即 60%，与服务端默认一致 */
const DEFAULT_COMPACT = '0.6'
const COMPACT_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: '0.5', label: '50%' },
  { value: DEFAULT_COMPACT, label: '60%（默认）' },
  { value: '0.7', label: '70%' },
  { value: '0.8', label: '80%' },
  { value: '0.9', label: '90%' },
]
const compactValue = (compactAt: AgentSettings['compactAt']) =>
  compactAt === undefined ? DEFAULT_COMPACT : String(compactAt)
const kib = (bytes: number) => `${number(Math.round(bytes / 1024))} KiB`

function contextLabel(context?: AgentContext) {
  if (!context || context.source === 'unavailable' || context.tokens === undefined) return '上下文'
  const prefix = context.source === 'estimate' ? '约 ' : ''
  if (context.limit && context.limit > 0)
    return `${prefix}${Math.round((context.tokens / context.limit) * 100)}%`
  return `${prefix}${number(context.tokens)} tokens`
}

/** 配置随会话保存；尚未发送的对话使用按智能体记住的偏好。 */
export function AgentControls({
  disabled,
  selectionCount,
}: {
  disabled: boolean
  selectionCount: number
}) {
  const { session, agent, preferences, pending, setSettings } = useAgent(
    useShallow((s) => ({
      session: s.session,
      agent: s.agent,
      preferences: s.modelPreferences,
      pending: !!s.pendingActions[`${s.session?.id}/configure`],
      setSettings: s.setSettings,
    })),
  )
  const kind = session?.agent ?? agent
  const settings = (session ? session.settings : preferences[kind]) ?? {}
  const refreshModels = useRef(false)
  const catalog = useQuery({
    queryKey: ['agent', 'models', kind],
    queryFn: () => {
      const refresh = refreshModels.current
      refreshModels.current = false
      return api.agentModels(kind, refresh)
    },
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const models = catalog.data?.models ?? []
  const effective = models.find(
    (model) =>
      model.id ===
      (settings.model ?? (kind === 'builtin' ? catalog.data?.defaultModel : undefined)),
  )
  const missing = !!settings.model && !!catalog.data && !catalog.data.error && !effective
  const defaultLabel = kind === 'builtin' ? '跟随平台默认' : '跟随 CLI 配置'
  const options = [
    { value: '', label: defaultLabel },
    ...models.map((model) => ({ value: model.id, label: model.title })),
    ...(settings.model && !models.some((model) => model.id === settings.model)
      ? [
          {
            value: settings.model,
            label: `${settings.model}${missing ? ' · 已不在目录中' : ''}`,
            disabled: true,
          },
        ]
      : []),
  ]
  const efforts = effective?.reasoningEfforts ?? []
  const effortMissing = !!settings.reasoningEffort && !efforts.includes(settings.reasoningEffort)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const error = catalog.error?.message ?? catalog.data?.error
  const blocked = disabled || pending

  return (
    <div className="mb-2 flex flex-col gap-1.5" aria-busy={pending}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Select
          aria-label="对话模型"
          value={settings.model ?? ''}
          options={options}
          disabled={blocked || catalog.isPending}
          onChange={(model) =>
            void setSettings({
              ...(model ? { model } : {}),
              ...(settings.compactAt === undefined ? {} : { compactAt: settings.compactAt }),
            })
          }
          className="h-7 min-w-0 max-w-48 flex-1 text-xs"
        />
        {(efforts.length > 0 || settings.reasoningEffort) && (
          <Select
            aria-label="推理强度"
            value={settings.reasoningEffort ?? ''}
            disabled={blocked || catalog.isPending || !!error}
            options={[
              { value: '', label: '默认推理' },
              ...efforts.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value })),
              ...(effortMissing
                ? [
                    {
                      value: settings.reasoningEffort!,
                      label: `${settings.reasoningEffort} · 待核对`,
                      disabled: true,
                    },
                  ]
                : []),
            ]}
            onChange={(reasoningEffort) =>
              void setSettings({
                ...(settings.model ? { model: settings.model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(settings.compactAt === undefined ? {} : { compactAt: settings.compactAt }),
              })
            }
            className="h-7 max-w-26 text-xs"
          />
        )}
        <button
          type="button"
          aria-label="上下文管理"
          aria-expanded={!!anchor}
          title="查看上下文来源和用量"
          className="ui-btn ui-btn-quiet ui-btn-xs ml-auto h-7 gap-1 text-ink-muted"
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        >
          <Icon name="layers" size={12} />
          {contextLabel(session?.context)}
        </button>
      </div>
      {kind !== 'builtin' && settings.model && (
        <p className="px-1 text-2xs leading-relaxed text-ink-subtle">
          恢复 CLI 默认配置会重新建立上下文，记录保留。
        </p>
      )}
      {(catalog.isPending || error || missing || pending) && (
        <div className="flex items-start gap-2 px-1 text-2xs text-ink-subtle">
          <span className="min-w-0 flex-1" role={error || missing ? 'alert' : 'status'}>
            {pending
              ? '正在保存对话配置…'
              : catalog.isPending
                ? '正在读取模型…'
                : error
                  ? `模型目录读取失败：${error}`
                  : '当前模型已不在目录中，请重新选择。'}
          </span>
          {error && (
            <button
              type="button"
              className="ui-btn ui-btn-quiet ui-btn-xs flex-none"
              disabled={catalog.isFetching || blocked}
              onClick={() => {
                refreshModels.current = true
                void catalog.refetch()
              }}
            >
              重新读取模型
            </button>
          )}
        </div>
      )}
      <AnimatePresence>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)} label="上下文管理" width={320}>
            <ContextDetails
              key={session?.id ?? kind}
              context={session?.context}
              model={effective?.title ?? settings.model ?? defaultLabel}
              builtin={kind === 'builtin'}
              selectionCount={selectionCount}
              disabled={blocked || !session}
              pending={pending}
              compactAt={settings.compactAt}
              onCompactAt={(value) => {
                const { compactAt: _, ...rest } = settings
                void setSettings(
                  value === DEFAULT_COMPACT
                    ? rest
                    : { ...rest, compactAt: value === 'off' ? 'off' : Number(value) },
                )
              }}
              compactDisabled={blocked}
            />
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}

function ContextDetails({
  context,
  model,
  builtin,
  selectionCount,
  disabled,
  pending,
  compactAt,
  onCompactAt,
  compactDisabled,
}: {
  context?: AgentContext
  model: string
  builtin: boolean
  selectionCount: number
  disabled: boolean
  pending: boolean
  compactAt: AgentSettings['compactAt']
  onCompactAt(value: string): void
  compactDisabled: boolean
}) {
  const known = context?.source !== 'unavailable' && context?.tokens !== undefined
  const percent =
    known && context?.limit && context.limit > 0
      ? Math.min(100, (context.tokens! / context.limit) * 100)
      : undefined
  const source =
    context?.source === 'estimate'
      ? '本地估算 · Plein 请求预算'
      : builtin
        ? '模型报告 · 最近一次请求（上限为 Plein 请求预算）'
        : 'CLI 报告 · 最近一次请求'
  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <h3 className="font-semibold text-ink">对话上下文</h3>
        <p className="mt-1 truncate text-ink-muted" title={model}>
          {model}
        </p>
      </div>
      <div className="rounded-md bg-surface-2 p-3">
        <p className="text-ink-subtle">{known ? source : '尚无可用的用量报告'}</p>
        {known ? (
          <>
            <p className="mt-1 text-sm font-medium tabular-nums">
              {context?.source === 'estimate' && '约 '}
              {number(context!.tokens!)}
              {context?.limit ? ` / ${number(context.limit)}` : ''} tokens
            </p>
            {percent !== undefined && (
              <div
                role="progressbar"
                aria-label={
                  context?.source === 'estimate' ? 'Plein 请求预算用量（估算）' : '上下文窗口用量'
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
                className="mt-2 h-1 overflow-hidden rounded-full bg-line"
              >
                <div
                  className={`h-full ${percent >= 80 ? 'bg-warning' : 'bg-accent'}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
            {context?.bytes !== undefined && (
              <p className="mt-2 text-ink-subtle">
                请求文本 {number(context.bytes)} bytes / {kib(context.bytesLimit ?? 256 * 1024)}
              </p>
            )}
            {context?.source === 'estimate' && (
              <p className="mt-2 leading-relaxed text-ink-subtle">
                估算包含系统指令、对话和工具定义；这里的上限是 Plein 的请求预算。
              </p>
            )}
            {builtin && context?.limitDeclared === false && (
              <p className="mt-2 leading-relaxed text-ink-subtle">
                模型未声明上下文窗口，按默认预算。
              </p>
            )}
            {builtin && context?.calibration !== undefined && (
              <p className="mt-2 leading-relaxed text-ink-subtle">
                估算已按平台报告的实际用量校准（×{context.calibration.toFixed(2)}）。
              </p>
            )}
            {context?.source === 'provider' && !context.limit && (
              <p className="mt-2 text-ink-subtle">CLI 未报告窗口上限。</p>
            )}
          </>
        ) : (
          <p className="mt-2 leading-relaxed text-ink-muted">
            {builtin
              ? '发送消息后显示本地请求估算。'
              : '由本机 CLI 管理上下文；收到用量事件后显示。'}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-ink-muted">
        <dt>系统指令</dt>
        <dd>{builtin ? '创作助手与画布工具' : 'Plein 指令及 CLI 自身配置'}</dd>
        <dt>当前画布</dt>
        <dd>按需读取元素和素材</dd>
        <dt>本轮选区</dt>
        <dd>{selectionCount ? `${selectionCount} 个元素` : '未附带选中元素'}</dd>
        <dt>{builtin ? '请求消息' : '历史对话'}</dt>
        <dd>{builtin ? (context ? `${context.messages} 条` : '发送后统计') : '由本机 CLI 维护'}</dd>
      </dl>
      {builtin && (
        <div className="flex items-center justify-between gap-3 text-ink-muted">
          <span className="flex-none">自动压缩</span>
          <Select
            aria-label="自动压缩"
            value={compactValue(compactAt)}
            disabled={compactDisabled}
            options={[
              ...COMPACT_OPTIONS,
              ...(COMPACT_OPTIONS.some((o) => o.value === compactValue(compactAt))
                ? []
                : [
                    {
                      value: compactValue(compactAt),
                      label: `${Math.round(Number(compactAt) * 100)}%`,
                      disabled: true,
                    },
                  ]),
            ]}
            onChange={onCompactAt}
            className="h-7 w-32 text-xs"
          />
        </div>
      )}
      {builtin && (
        <p className="-mt-1 leading-relaxed text-ink-subtle">
          历史请求达到上下文预算的这个比例时，把较早的对话压缩成摘要。每一步都会重发整段上下文，大窗口模型建议调低。
        </p>
      )}
      {builtin && !!context?.compactedAt && (
        <p className="leading-relaxed text-ink-subtle">
          较早的 {context.compactedTurns ?? 0} 轮对话已在{' '}
          {new Date(context.compactedAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          自动压缩为摘要，随每次请求发送；完整记录仍保留。
        </p>
      )}
      {!!context?.omittedRounds && (
        <p className="leading-relaxed text-ink-subtle">
          为满足请求预算，较早的 {context.omittedRounds} 组历史未发送，完整记录仍保留。
        </p>
      )}
      {context?.resetAt && (
        <p role="status" className="text-ink-subtle">
          已从{' '}
          {new Date(context.resetAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          重新建立上下文
        </p>
      )}
      <div className="border-t border-line pt-3">
        <p className="mb-2 leading-relaxed text-ink-subtle">
          重置后，从下一条消息重新开始。历史记录、画布和已提交任务保留，旧对话和摘要不再发送给模型。
        </p>
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm w-full"
          disabled={disabled}
          aria-busy={pending}
          onClick={() => void useAgent.getState().resetContext()}
        >
          重置上下文
        </button>
      </div>
    </div>
  )
}
