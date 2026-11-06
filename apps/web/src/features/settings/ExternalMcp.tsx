import { useQuery } from '@tanstack/react-query'
import { EXTERNAL_MCP_SCOPES, type ExternalMcpScope, type ExternalMcpStatus } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { queryClient, queryKeys } from '../../api/query'
import { Icon } from '../../ui/icons'
import { Segmented } from '../../ui/Segmented'
import { type Client, snippet } from './externalMcpConfig'

const CLIENTS: Array<{ value: Client; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'json', label: 'Cursor 等' },
  { value: 'claude-desktop', label: 'Claude Desktop' },
]

const SCOPE_LABELS: Record<ExternalMcpScope, { label: string; hint: string }> = {
  read: { label: '读取', hint: '查看画布、元素、结果' },
  edit: { label: '编辑', hint: '新建、修改、连线、整理' },
  run: { label: '运行', hint: '调用模型生成，会产生费用' },
  destructive: { label: '删除', hint: '删除元素、结果、检查点' },
}

/** 对外开放 MCP：生成令牌，给 Claude Code、Cursor、Claude Desktop 一段能直接贴的配置 */
export function ExternalMcp() {
  const {
    data: status,
    error: loadError,
    isFetching,
    refetch,
  } = useQuery({ queryKey: queryKeys.mcpExternal, queryFn: api.externalMcp })
  const [token, setToken] = useState<string | null>(null)
  const [client, setClient] = useState<Client>('claude-code')
  const [busy, setBusy] = useState(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('Claude')
  const [scopes, setScopes] = useState<ExternalMcpScope[]>(['read', 'edit', 'run'])
  const [dailyRunLimit, setDailyRunLimit] = useState('')
  useEffect(() => {
    if (copiedText === null) return
    const timer = setTimeout(() => setCopiedText(null), 1500)
    return () => clearTimeout(timer)
  }, [copiedText])
  const url = `${window.location.origin}/mcp`

  const issue = async () => {
    setBusy(true)
    setError(null)
    try {
      const limit = Number.parseInt(dailyRunLimit, 10)
      const issued = await api.issueExternalMcp({
        name: name.trim() || undefined,
        scopes,
        ...(limit > 0 ? { dailyRunLimit: limit } : {}),
      })
      await queryClient.cancelQueries({ queryKey: queryKeys.mcpExternal, exact: true })
      const { token: secret, ...info } = issued
      queryClient.setQueryData<ExternalMcpStatus>(queryKeys.mcpExternal, (prev) => ({
        enabled: true,
        createdAt: prev?.createdAt ?? issued.createdAt,
        tokens: [...(prev?.tokens ?? []), info],
      }))
      setToken(secret)
    } catch (err) {
      setError(`生成令牌失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.revokeExternalMcp()
      await queryClient.cancelQueries({ queryKey: queryKeys.mcpExternal, exact: true })
      queryClient.setQueryData<ExternalMcpStatus>(queryKeys.mcpExternal, {
        enabled: false,
        tokens: [],
      })
      setToken(null)
    } catch (err) {
      setError(`关闭连接失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const revokeOne = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.revokeExternalMcpToken(id)
      await queryClient.cancelQueries({ queryKey: queryKeys.mcpExternal, exact: true })
      queryClient.setQueryData<ExternalMcpStatus>(queryKeys.mcpExternal, (prev) => {
        const tokens = (prev?.tokens ?? []).filter((t) => t.id !== id)
        return { ...prev, enabled: tokens.length > 0, tokens }
      })
    } catch (err) {
      setError(`撤销令牌失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const toggleScope = (scope: ExternalMcpScope) =>
    setScopes((cur) => (cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]))
  const tokens = status?.tokens ?? []
  const text = token ? snippet(client, url, token) : ''
  const copied = copiedText === text
  const copy = async () => {
    setError(null)
    setCopiedText(null)
    try {
      await navigator.clipboard.writeText(text)
      setCopiedText(text)
    } catch {
      setError('复制失败，请手动选择并复制上方配置。')
    }
  }

  if (!status)
    return loadError ? (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-danger">
          读取连接状态失败：{loadError.message}
        </p>
        <button
          type="button"
          className="ui-btn ui-btn-secondary self-start"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {isFetching ? '正在重试…' : '重试'}
        </button>
      </div>
    ) : (
      <p role="status" className="text-sm text-ink-subtle">
        正在读取连接状态…
      </p>
    )
  return (
    <div className="flex flex-col gap-3">
      {token ? (
        <>
          <Segmented label="客户端" value={client} onChange={setClient} options={CLIENTS} />
          <div className="relative">
            <pre
              data-testid="external-mcp-config"
              className="ui-scrollbar max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 pr-20 font-mono text-xs whitespace-pre-wrap break-all ring-1 ring-line ring-inset"
            >
              {text}
            </pre>
            <button
              type="button"
              className="ui-btn ui-btn-xs ui-btn-secondary absolute top-2 right-2"
              onClick={copy}
            >
              <Icon name={copied ? 'check' : 'copy'} size={12} />
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <p className="ui-note text-ink-muted">
            令牌只显示这一次，拿着它就能操作你的画布，不要发给别人。Plein 的端口变了要重新配置。
          </p>
        </>
      ) : status.enabled ? (
        <p className="ui-note text-ink-muted">
          已开启。令牌只在生成时显示一次；忘了就新增一枚并撤销旧的。每枚令牌只能做被勾选的事，花钱或删除的操作
          AI 应用会先请你确认。
        </p>
      ) : (
        <p className="ui-note text-ink-muted">
          开启后，Claude Code、Cursor、Claude Desktop 这类应用可以连到本机的
          Plein，用同一套工具操作画布。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">名称</span>
          <input
            className="ui-input"
            value={name}
            maxLength={40}
            aria-label="令牌名称"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">令牌权限</legend>
          {EXTERNAL_MCP_SCOPES.map((scope) => (
            <label
              key={scope}
              className="flex items-center gap-1.5 text-sm"
              title={SCOPE_LABELS[scope].hint}
            >
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              {SCOPE_LABELS[scope].label}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">每天最多运行</span>
          <input
            className="ui-input w-20"
            inputMode="numeric"
            placeholder="不限"
            value={dailyRunLimit}
            aria-label="每日运行次数上限"
            onChange={(e) => setDailyRunLimit(e.target.value.replace(/\D/g, ''))}
          />
          <span className="text-ink-muted">次</span>
        </label>
      </div>
      {tokens.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="已有令牌">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-sm">
              <span className="font-medium">{t.name}</span>
              <span className="text-ink-muted">
                {t.scopes.map((s) => SCOPE_LABELS[s].label).join(' / ')}
                {t.dailyRunLimit ? ` · 每天 ${t.dailyRunLimit} 次运行` : ''}
                {t.lastUsedAt ? ` · 最近使用 ${new Date(t.lastUsedAt).toLocaleString()}` : ''}
              </span>
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet ml-auto"
                disabled={busy}
                aria-label={`撤销令牌 ${t.name}`}
                onClick={() => void revokeOne(t.id)}
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={busy || scopes.length === 0}
          onClick={issue}
        >
          {status.enabled ? '新增令牌' : '生成连接令牌'}
        </button>
        {status.enabled && (
          <button type="button" className="ui-btn ui-btn-quiet" disabled={busy} onClick={revoke}>
            关闭全部
          </button>
        )}
      </div>
    </div>
  )
}
