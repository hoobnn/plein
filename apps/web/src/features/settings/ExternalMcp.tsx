import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { queryClient, queryKeys } from '../../api/query'
import { Icon } from '../../ui/icons'
import { Segmented } from '../../ui/Segmented'

type Client = 'claude-code' | 'json' | 'claude-desktop'

/** mcp-remote 从环境变量取请求头，避免参数里的空格在部分系统上被拆开 */
const AUTH_ARG = ['Authorization:$', '{AUTH_HEADER}'].join('')

const CLIENTS: Array<{ value: Client; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'json', label: 'Cursor 等' },
  { value: 'claude-desktop', label: 'Claude Desktop' },
]

/** 各家客户端的接入配置 */
function snippet(client: Client, url: string, token: string) {
  if (client === 'claude-code')
    return `claude mcp add --transport http plein ${url} --header "Authorization: Bearer ${token}"`
  const server =
    client === 'json'
      ? { url, headers: { Authorization: `Bearer ${token}` } }
      : // Claude Desktop 的配置文件只接本机命令，经 mcp-remote 转到 HTTP
        {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', AUTH_ARG],
          env: { AUTH_HEADER: `Bearer ${token}` },
        }
  return JSON.stringify({ mcpServers: { plein: server } }, null, 2)
}

const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.mcpExternal })

/** 对外开放 MCP：生成令牌，给 Claude Code、Cursor、Claude Desktop 一段能直接贴的配置 */
export function ExternalMcp() {
  const { data: status } = useQuery({ queryKey: queryKeys.mcpExternal, queryFn: api.externalMcp })
  const [token, setToken] = useState<string | null>(null)
  const [client, setClient] = useState<Client>('claude-code')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/mcp`

  const issue = async () => {
    setBusy(true)
    try {
      setToken((await api.issueExternalMcp()).token)
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const revoke = async () => {
    setBusy(true)
    try {
      await api.revokeExternalMcp()
      setToken(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const text = token ? snippet(client, url, token) : ''
  const copy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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
