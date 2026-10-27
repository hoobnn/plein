import type { AgentKind, AgentSkill, AgentSkillCatalog } from '@plein/protocol'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { Select } from '../../ui/Select'
import { useAgent } from './store'

const EFFECTS: Record<string, string> = {
  read: '只读',
  edit: '修改画布',
  run: '运行任务',
  destructive: '删除',
  dynamic: '按操作确认',
}

export function AgentSkillsButton({
  canvasId,
  selectionCount,
  disabled,
}: {
  canvasId: string
  selectionCount: number
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const agent = useAgent((s) => s.session?.agent ?? s.agent)
  const sessionId = useAgent((s) => s.session?.id ?? null)
  return (
    <>
      <button
        type="button"
        className="ui-btn ui-btn-xs ui-btn-quiet h-6 gap-1 px-1.5 text-2xs text-ink-subtle"
        aria-label="技能与画布能力"
        title="查看技能、画布工具和使用方式"
        onClick={() => setOpen(true)}
      >
        <Icon name="sparkle" size={12} />
        技能
      </button>
      <Presence>
        {open && (
          <Modal
            label="技能与画布能力"
            onClose={() => setOpen(false)}
            top
            isolateKeys
            className="h-[min(700px,100%)] max-w-200"
          >
            <ModalHeader title="技能与画布能力" onClose={() => setOpen(false)} />
            <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
              <SkillBrowser
                agent={agent}
                scopeKey={sessionId ?? ''}
                selectionCount={selectionCount}
                disabled={disabled}
                onUse={(skill) => {
                  const accepted = useAgent
                    .getState()
                    .chooseSkill(canvasId, skill, agent, sessionId)
                  if (accepted) setOpen(false)
                  return accepted
                }}
              />
            </div>
          </Modal>
        )}
      </Presence>
    </>
  )
}

/** 管理页和画布内的技能选择器复用同一份目录与状态。 */
export function SkillBrowser({
  agent: fixedAgent,
  selectionCount = 0,
  disabled = false,
  onUse,
  scopeKey,
}: {
  agent?: AgentKind
  selectionCount?: number
  disabled?: boolean
  onUse?(skill: AgentSkill): boolean | void
  scopeKey?: string
}) {
  const preferred = useAgent((s) => s.session?.agent ?? s.agent)
  const available = useAgent((s) => s.status?.agents)
  const [selectedAgent, setSelectedAgent] = useState(preferred)
  const agent = fixedAgent ?? selectedAgent
  const client = useQueryClient()
  const key = ['agent', 'skills', agent]
  const force = useRef(false)
  const generation = useRef(0)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'skills' | 'tools'>('skills')
  const [source, setSource] = useState('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const catalog = useQuery({
    queryKey: key,
    queryFn: () => {
      const refresh = force.current
      force.current = false
      return api.agentSkills(agent, refresh)
    },
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    const current = ++generation.current
    setExpanded(null)
    setError(null)
    setSource('all')
    setPending(null)
    return () => {
      generation.current = current + 1
    }
  }, [agent, scopeKey])
  const search = query.trim().toLocaleLowerCase()
  const skills = (catalog.data?.skills ?? []).filter(
    (skill) =>
      (source === 'all' || skill.source === source) &&
      `${skill.title} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(search),
  )
  const capabilities = (catalog.data?.capabilities ?? []).filter((cap) =>
    `${cap.title} ${cap.name} ${cap.description} ${cap.group}`.toLocaleLowerCase().includes(search),
  )
  const reportUse = (skill: AgentSkill) => {
    const accepted = onUse?.(skill)
    if (accepted === false)
      setError('技能未选用：当前对话或画布状态已变化，请回到助手确认状态后重试。')
  }
  const change = async (skill: AgentSkill, use = false) => {
    if (pending || disabled) return
    const mine = generation.current
    setPending(skill.id)
    setError(null)
    try {
      const updated = await api.toggleAgentSkill(agent, skill.id, use || !skill.enabled)
      client.setQueryData<AgentSkillCatalog>(key, (old) =>
        old ? { ...old, skills: old.skills.map((s) => (s.id === skill.id ? updated : s)) } : old,
      )
      if (mine === generation.current && use) reportUse(updated)
    } catch (err) {
      if (mine === generation.current) setError((err as Error).message)
    } finally {
      if (mine === generation.current) setPending(null)
    }
  }
  const sourceLabel = (skill: AgentSkill) =>
    skill.source === 'plein' ? 'Plein 画布技能' : 'Codex 本机 Skill'
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-ink-muted">
        选择技能，把创作方法与画布工具带入下一条消息。选用后仍可修改需求；点击发送才开始处理。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!fixedAgent && (
          <Select
            aria-label="技能所属智能体"
            value={agent}
            disabled={!!pending}
            options={(available?.length ? available : [{ id: 'builtin', name: '内置' }]).map(
              (a) => ({ value: a.id, label: a.name }),
            )}
            onChange={(v) => setSelectedAgent(v as AgentKind)}
            className="h-8 text-xs"
          />
        )}
        <div className="flex gap-1" role="group" aria-label="技能目录视图">
          <button
            type="button"
            aria-pressed={tab === 'skills'}
            className={`ui-btn ui-btn-sm ${tab === 'skills' ? 'ui-btn-secondary' : 'ui-btn-quiet'}`}
            onClick={() => setTab('skills')}
          >
            技能
          </button>
          <button
            type="button"
            aria-pressed={tab === 'tools'}
            className={`ui-btn ui-btn-sm ${tab === 'tools' ? 'ui-btn-secondary' : 'ui-btn-quiet'}`}
            onClick={() => setTab('tools')}
          >
            画布能力
          </button>
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-btn-sm ml-auto"
          disabled={catalog.isFetching || !!pending}
          onClick={() => {
            force.current = true
            void catalog.refetch()
          }}
        >
          刷新技能
        </button>
      </div>
      <div className="flex gap-2">
        <input
          aria-label="搜索技能与画布能力"
          placeholder="搜索名称、用途或工具…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ui-input min-w-0 flex-1"
        />
        {tab === 'skills' && (
          <Select
            aria-label="技能来源"
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: '全部来源' },
              { value: 'plein', label: 'Plein' },
              ...(agent === 'codex' ? [{ value: 'codex', label: 'Codex' }] : []),
            ]}
            className="h-8 text-xs"
          />
        )}
      </div>
      {(error || catalog.error || catalog.data?.error) && (
        <p role="alert" className="text-xs text-danger">
          {error ?? catalog.error?.message ?? catalog.data?.error}
        </p>
      )}
      {catalog.data?.warnings?.map((warning) => (
        <p key={warning} className="text-xs text-ink-subtle">
          {warning}
        </p>
      ))}
      {catalog.isPending ? (
        <p role="status" className="p-4 text-center text-xs text-ink-subtle">
          正在读取技能目录…
        </p>
      ) : tab === 'tools' ? (
        <>
          <p className="text-xs text-ink-subtle">
            这些工具来自当前画布能力注册表。技能复用同一套能力，执行仍遵循确认与撤销规则。
          </p>
          <div className="flex flex-col gap-2">
            {capabilities.map((cap) => (
              <article key={cap.name} className="rounded-lg border border-line px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="min-w-0 flex-1 text-sm font-medium">{cap.title}</h3>
                  <span className="ui-tag">{EFFECTS[cap.effect]}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{cap.description}</p>
                <p className="mt-1 text-2xs break-all text-ink-subtle">
                  {cap.name} · {cap.group}
                </p>
              </article>
            ))}
          </div>
          {!capabilities.length && (
            <p className="py-4 text-center text-xs text-ink-subtle">没有匹配的画布能力</p>
          )}
        </>
      ) : (
        <>
          <p className="text-xs text-ink-subtle">
            Plein 开关保存在当前用户的 Plein 配置中。Codex 开关会修改本机 Codex
            的技能配置，从后续请求生效。
          </p>
          <div className="flex flex-col gap-2">
            {skills.map((skill) => {
              const applicable = skill.selection !== 'required' || selectionCount > 0
              const busy = !!pending || disabled
              return (
                <article
                  key={skill.id}
                  className="rounded-lg border border-line p-3"
                  aria-label={`技能：${skill.title}`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">{skill.title}</h3>
                      <p className="mt-0.5 text-2xs text-ink-subtle">
                        {sourceLabel(skill)}
                        {skill.scope ? ` · ${skill.scope}` : ''}
                        {skill.selection === 'required' ? ' · 需要选区' : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`${skill.source === 'codex' ? '在 Codex 中启用' : '启用技能'}：${skill.title}`}
                      aria-checked={skill.enabled}
                      aria-busy={pending === skill.id}
                      disabled={busy || !skill.canToggle}
                      className={`ui-btn ui-btn-xs ${skill.enabled ? 'ui-btn-secondary text-accent' : 'ui-btn-quiet text-ink-subtle'}`}
                      onClick={() => void change(skill)}
                    >
                      {skill.enabled ? '已启用' : '已停用'}
                    </button>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-muted">{skill.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      aria-label={`查看技能：${skill.title}`}
                      aria-expanded={expanded === skill.id}
                      className="ui-btn ui-btn-quiet ui-btn-xs"
                      onClick={() => setExpanded(expanded === skill.id ? null : skill.id)}
                    >
                      查看指引与工具
                    </button>
                    {onUse && (
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-xs ml-auto"
                        disabled={busy || !applicable || (!skill.enabled && !skill.canToggle)}
                        onClick={() => {
                          if (skill.enabled) reportUse(skill)
                          else void change(skill, true)
                        }}
                      >
                        {!applicable
                          ? '先选择画布元素'
                          : skill.enabled
                            ? '使用此技能'
                            : '启用并使用'}
                      </button>
                    )}
                  </div>
                  {expanded === skill.id && (
                    <SkillDetail
                      agent={agent}
                      skill={skill}
                      capabilities={catalog.data?.capabilities ?? []}
                    />
                  )}
                </article>
              )
            })}
          </div>
          {!skills.length && (
            <p className="py-4 text-center text-xs text-ink-subtle">没有匹配的技能</p>
          )}
        </>
      )}
    </div>
  )
}

function SkillDetail({
  agent,
  skill,
  capabilities,
}: {
  agent: AgentKind
  skill: AgentSkill
  capabilities: AgentSkillCatalog['capabilities']
}) {
  const detail = useQuery({
    queryKey: ['agent', 'skill', agent, skill.id],
    queryFn: () => api.agentSkill(agent, skill.id),
    staleTime: 30_000,
    retry: false,
  })
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 text-xs">
      {skill.path && <p className="break-all text-ink-subtle">来源：{skill.path}</p>}
      <div className="flex flex-wrap gap-1">
        {skill.capabilities.map((name) => (
          <span key={name} className="ui-tag" title={name}>
            {capabilities.find((cap) => cap.name === name)?.title ?? name}
          </span>
        ))}
      </div>
      {detail.isPending ? (
        <p role="status">正在读取技能指引…</p>
      ) : detail.error ? (
        <div role="alert">
          <p>{detail.error.message}</p>
          <button
            type="button"
            className="ui-btn ui-btn-xs ui-btn-quiet mt-1"
            onClick={() => void detail.refetch()}
          >
            重试读取指引
          </button>
        </div>
      ) : (
        <pre className="ui-scrollbar max-h-64 overflow-y-auto rounded-md bg-surface-2 p-3 font-sans leading-relaxed whitespace-pre-wrap break-words">
          {detail.data?.instructions}
        </pre>
      )}
    </div>
  )
}
