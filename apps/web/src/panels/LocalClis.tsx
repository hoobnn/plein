import type { LocalCliInfo } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { queryClient, queryKeys } from '../api/query'
import { useAgent } from '../stores/agent'
import { Icon } from '../ui/icons'

/** 本机的 Claude Code、Codex：装没装、登没登录、有没有新版本，能一键更新 */
export function LocalClis() {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: queryKeys.localClis,
    queryFn: () => api.localClis(),
    staleTime: 5 * 60_000,
  })
  const [refreshing, setRefreshing] = useState(false)

  const recheck = async () => {
    setRefreshing(true)
    try {
      queryClient.setQueryData(queryKeys.localClis, await api.localClis(true))
      // 智能体面板里的可用列表也跟着刷新
      void useAgent.getState().loadStatus(true)
    } catch {
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-sm text-danger">{(error as Error).message}</p>}
      {!data && !error && (
        <div className="flex items-center gap-2 text-sm text-ink-subtle" role="status">
          <span className="ui-spinner size-4" />
          正在检测本机的 AI 命令行工具…
        </div>
      )}
      {data && (
        <ul className="rounded-lg ring-1 ring-line">
          {data.map((cli) => (
            <CliRow key={cli.id} cli={cli} />
          ))}
        </ul>
      )}
      <div>
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={refreshing || isFetching}
          onClick={() => void recheck()}
        >
          <Icon name="retry" />
          {refreshing ? '检测中…' : '重新检测'}
        </button>
      </div>
    </div>
  )
}

function CliRow({ cli }: { cli: LocalCliInfo }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string; output?: string } | null>(null)

  const update = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await api.updateLocalCli(cli.id)
      queryClient.setQueryData<LocalCliInfo[]>(queryKeys.localClis, (list) =>
        list?.map((c) => (c.id === r.cli.id ? r.cli : c)),
      )
      void useAgent.getState().loadStatus(true)
      setResult(
        r.ok
          ? { ok: true, text: `已更新到 ${r.cli.version ?? '最新版本'}` }
          : { ok: false, text: '更新没有成功', output: r.output },
      )
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      className="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0"
      data-cli={cli.id}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{cli.name}</span>
            {cli.installed && cli.version && (
              <span className="font-mono text-xs text-ink-subtle">{cli.version}</span>
            )}
            <StatusTag cli={cli} />
          </div>
          {cli.path && (
            <span className="block truncate font-mono text-xs text-ink-subtle" title={cli.path}>
              {cli.path}
            </span>
          )}
        </div>
        {cli.updateAvailable && cli.updateCommand && (
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={busy}
            title={`运行：${cli.updateCommand}`}
            onClick={() => void update()}
          >
            {busy ? <span className="ui-spinner size-4" /> : <Icon name="download" />}
            {busy ? '更新中…' : `更新到 ${cli.latest}`}
          </button>
        )}
      </div>
      {!cli.installed && <Command label="在终端里安装" command={cli.installCommand} />}
      {cli.installed && cli.loggedIn === false && (
        <Command label="还没登录，在终端里运行" command={cli.loginCommand} />
      )}
      {cli.updateAvailable && !cli.updateCommand && (
        <p className="text-xs text-ink-muted">
          有新版本 {cli.latest}，但识别不出安装方式，请按你安装时的方式手动更新。
        </p>
      )}
      {result && (
        <div className="flex flex-col gap-2">
          <p className={`text-xs ${result.ok ? 'text-success' : 'text-danger'}`} role="status">
            {result.text}
          </p>
          {result.output && (
            <pre className="ui-scrollbar max-h-40 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-2xs whitespace-pre-wrap break-all text-ink-muted">
              {result.output}
            </pre>
          )}
        </div>
      )}
    </li>
  )
}

function StatusTag({ cli }: { cli: LocalCliInfo }) {
  if (!cli.installed) return <span className="ui-tag">未安装</span>
  if (cli.updateAvailable)
    return <span className="ui-tag ui-tag-accent">有新版本 {cli.latest}</span>
  if (cli.loggedIn === false) return <span className="ui-tag ui-tag-warning">未登录</span>
  if (cli.loggedIn) return <span className="ui-tag ui-tag-success">可以使用</span>
  return null
}

/** 一条要在终端里运行的命令，带复制按钮 */
function Command({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(command).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="flex items-center gap-2 rounded-md bg-surface-2 py-1 pr-1 pl-2.5 ring-1 ring-line ring-inset">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
        <button type="button" className="ui-btn ui-btn-xs ui-btn-quiet" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  )
}
