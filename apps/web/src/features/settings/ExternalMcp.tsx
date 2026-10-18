import { useQuery } from '@tanstack/react-query'
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

const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.mcpExternal })

/** 对外开放 MCP：生成令牌，给 Claude Code、Cursor、Claude Desktop 一段能直接贴的配置 */
export function ExternalMcp() {
  const { data: status } = useQuery({ queryKey: queryKeys.mcpExternal, queryFn: api.externalMcp })
  const [token, setToken] = useState<string | null>(null)
  const [client, setClient] = useState<Client>('claude-code')
  const [busy, setBusy] = useState(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
      setToken((await api.issueExternalMcp()).token)
      await refresh()
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
      setToken(null)
      await refresh()
    } catch (err) {
      setError(`关闭连接失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
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

  if (!status) return null
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
          <p className="text-xs text-ink-subtle">
            令牌只显示这一次，拿着它就能操作你的画布，不要发给别人。Plein 的端口变了要重新配置。
          </p>
        </>
      ) : status.enabled ? (
        <p className="text-sm text-ink-muted">
          已开启。令牌只在生成时显示一次；忘了就重新生成，旧的会失效。
        </p>
      ) : (
        <p className="text-sm text-ink-subtle">
          开启后，Claude Code、Cursor、Claude Desktop 这类应用可以连到本机的
          Plein，用和小满一样的工具操作画布。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className="ui-btn ui-btn-secondary" disabled={busy} onClick={issue}>
          {status.enabled ? '重新生成令牌' : '生成连接令牌'}
        </button>
        {status.enabled && (
          <button type="button" className="ui-btn ui-btn-quiet" disabled={busy} onClick={revoke}>
            关闭
          </button>
        )}
      </div>
    </div>
  )
}
