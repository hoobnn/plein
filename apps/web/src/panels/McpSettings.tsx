import type { McpServerInput, McpServerView, McpTransport } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { queryClient, queryKeys } from '../api/query'
import { Icon } from '../ui/icons'
import { Presence, useExit } from '../ui/Presence'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'

const input = 'ui-input ui-input-lg w-full'
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/

const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers })

/** 命令行拆成命令和参数：按空白分开，引号里的空白保留 */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
    } else cur += ch
  }
  if (started || cur) out.push(cur)
  return out
}

const joinCommand = (parts: string[]) =>
  parts.map((p) => (/[\s"']/.test(p) || !p ? JSON.stringify(p) : p)).join(' ')

/** 每行一个 KEY=VALUE；KEY= 表示删除 */
function parseSecrets(text: string): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const i = line.indexOf('=')
    const key = (i < 0 ? line : line.slice(0, i)).trim()
    if (!KEY.test(key)) return `「${key}」不是有效的名字（字母、数字、下划线、短横线）`
    out[key] = i < 0 ? '' : line.slice(i + 1).trim()
  }
  return out
}

const detailOf = (s: McpServerView) =>
  s.transport === 'stdio' ? joinCommand([s.command ?? '', ...(s.args ?? [])]) : (s.url ?? '')

/** 外部 MCP 服务：添加后画布上的「MCP 工具」节点和小满都能调用它们的工具 */
export function McpSettings() {
  const { data: servers, error } = useQuery({
    queryKey: queryKeys.mcpServers,
    queryFn: api.mcpServers,
  })
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-sm text-danger">{(error as Error).message}</p>}
      {servers && servers.length > 0 && (
        <ul className="rounded-lg ring-1 ring-line">
          {servers.map((s) => (
            <McpRow
              key={s.id}
              server={s}
              open={open === s.id}
              onToggleOpen={() => setOpen(open === s.id ? null : s.id)}
            />
          ))}
        </ul>
      )}
      {servers?.length === 0 && !adding && (
        <p className="text-sm text-ink-subtle">
          还没有添加服务。可以接本机命令（如 npx、uvx 启动的服务），也可以接远程地址。
        </p>
      )}
      <Presence>
        {adding && (
          <Editor
            onDone={(saved) => {
              setAdding(false)
              if (saved) setOpen(saved.id)
            }}
          />
        )}
      </Presence>
      {!adding && (
        <div>
          <button type="button" className="ui-btn ui-btn-secondary" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            添加 MCP 服务
          </button>
        </div>
      )}
    </div>
  )
}

function McpRow({
  server,
  open,
  onToggleOpen,
}: {
  server: McpServerView
  open: boolean
  onToggleOpen(): void
}) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const bodyId = `mcp-${server.id}`

  const test = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const tools = await api.mcpTools(server.id, true)
      queryClient.setQueryData(queryKeys.mcpTools(server.id), tools)
      setStatus({
        ok: true,
        text: tools.length
          ? `连接正常，${tools.length} 个工具：${tools
              .slice(0, 6)
              .map((t) => t.name)
              .join('、')}${tools.length > 6 ? '…' : ''}`
          : '连接正常，但没有提供工具',
      })
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)
    try {
      await api.updateMcpServer(server.id, { ...inputOf(server), enabled })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.deleteMcpServer(server.id)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="border-b border-line last:border-b-0" data-mcp={server.name}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            className={`flex-none text-ink-subtle transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <Icon name="chevronRight" size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{server.name}</span>
            <span className="block truncate font-mono text-xs text-ink-subtle">
              {detailOf(server)}
            </span>
          </span>
          <span className="ui-tag">{server.transport === 'stdio' ? '本机命令' : '远程'}</span>
        </button>
        <Switch
          checked={server.enabled}
          disabled={busy}
          label={`启用 ${server.name}`}
          onChange={setEnabled}
        />
      </div>
      {open && (
        <div id={bodyId} className="flex flex-col gap-4 px-4 pb-4 pl-10.5">
          <Editor server={server} onDone={() => {}} />
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`mr-auto text-xs ${status && !status.ok ? 'text-danger' : 'text-ink-muted'}`}
              role="status"
            >
              {status?.text}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={remove}
              className="ui-btn ui-btn-quiet text-danger"
            >
              删除
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={test}
              className="ui-btn ui-btn-secondary"
            >
              {busy ? '连接中…' : '测试连接'}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function inputOf(s: McpServerView): McpServerInput {
  return {
    name: s.name,
    transport: s.transport,
    ...(s.transport === 'stdio' ? { command: s.command, args: s.args ?? [] } : { url: s.url }),
    enabled: s.enabled,
  }
}

/** 新增（不给 server）或修改一个服务 */
function Editor({
  server,
  onDone,
}: {
  server?: McpServerView
  onDone(saved: McpServerView | null): void
}) {
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'stdio')
  const [command, setCommand] = useState(server?.transport === 'stdio' ? detailOf(server) : '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [secrets, setSecrets] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const exit = useExit()

  const save = async () => {
    const parsed = parseSecrets(secrets)
    if (typeof parsed === 'string') return setMessage(parsed)
    const [cmd, ...args] = splitCommand(command)
    const body: McpServerInput = {
      name: name.trim() || (transport === 'stdio' ? (cmd ?? '') : url),
      transport,
      ...(transport === 'stdio' ? { command: cmd, args } : { url: url.trim() }),
      secrets: parsed,
      ...(server ? { enabled: server.enabled } : {}),
    }
    setBusy(true)
    setMessage(null)
    try {
      const saved = server
        ? await api.updateMcpServer(server.id, body)
        : await api.createMcpServer(body)
      await refresh()
      setSecrets('')
      setMessage(server ? '已保存' : null)
      onDone(saved)
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const secretHint =
    transport === 'stdio'
      ? '环境变量，每行一个 KEY=VALUE'
      : '请求头，每行一个，如 Authorization=Bearer …'
  return (
    <div
      {...exit}
      className={`flex flex-col gap-3 ${server ? '' : 'ui-pop ui-pop-up rounded-lg p-4 ring-1 ring-line'}`}
    >
      <label className="ui-field">
        <span className="ui-label">名称</span>
        <input
          className={input}
          value={name}
          placeholder="如：网页搜索"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <Segmented
        label="连接方式"
        value={transport}
        onChange={setTransport}
        options={[
          { value: 'stdio', label: '本机命令' },
          { value: 'http', label: '远程地址' },
        ]}
      />
      {transport === 'stdio' ? (
        <label className="ui-field">
          <span className="ui-label">命令</span>
          <input
            className={`${input} font-mono`}
            value={command}
            spellCheck={false}
            placeholder="npx -y @modelcontextprotocol/server-everything"
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
      ) : (
        <label className="ui-field">
          <span className="ui-label">地址</span>
          <input
            className={`${input} font-mono`}
            value={url}
            spellCheck={false}
            placeholder="https://example.com/mcp"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
      )}
      <label className="ui-field">
        <span className="ui-label">
          {transport === 'stdio' ? '环境变量（可选）' : '请求头（可选）'}
        </span>
        <textarea
          className={`${input} h-20 py-2 font-mono`}
          value={secrets}
          spellCheck={false}
          placeholder={secretHint}
          onChange={(e) => setSecrets(e.target.value)}
        />
        {!!server?.secretKeys.length && (
          <span className="ui-help">
            已保存：{server.secretKeys.join('、')}。留空表示不修改，写 KEY= 删除。
          </span>
        )}
      </label>
      <div className="flex items-center justify-end gap-2">
        {message && (
          <span className="mr-auto text-xs text-ink-muted" role="status">
            {message}
          </span>
        )}
        {!server && (
          <button type="button" className="ui-btn ui-btn-quiet" onClick={() => onDone(null)}>
            取消
          </button>
        )}
        <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={save}>
          {server ? '保存' : '添加'}
        </button>
      </div>
    </div>
  )
}
