import { MCP_INPUT_HOLE, mcpArgumentsTemplate } from '@plein/nodes'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'

const NONE = '__none'

/** 参数 JSON 写错时的提示；没错返回 null */
function jsonProblem(text: string) {
  try {
    const v = JSON.parse(text.trim() || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? null : '参数要是一个 JSON 对象'
  } catch {
    return '参数不是有效的 JSON'
  }
}

/** MCP 工具节点的参数：选服务、选工具、填 JSON 参数（{{input}} 换成上游文字） */
export function McpToolFields({
  params,
  set,
}: {
  params: Record<string, unknown>
  set(key: string, value: unknown): void
}) {
  const server = String(params.server ?? '')
  const tool = String(params.tool ?? '')
  const args = String(params.arguments ?? '{}')
  const [draft, setDraft] = useState<string | null>(null)
  const { data: servers } = useQuery({ queryKey: queryKeys.mcpServers, queryFn: api.mcpServers })
  const tools = useQuery({
    queryKey: queryKeys.mcpTools(server),
    queryFn: () => api.mcpTools(server),
    enabled: !!server,
    staleTime: 60_000,
  })
  const info = tools.data?.find((t) => t.name === tool)
  const enabled = servers?.filter((s) => s.enabled) ?? []
  const text = draft ?? args
  const problem = jsonProblem(text)

  const pickTool = (name: string) => {
    set('tool', name)
    const next = tools.data?.find((t) => t.name === name)
    // 换工具时参数换成新工具的模板（原来的多半对不上）
    if (next) {
      const template = mcpArgumentsTemplate(next.inputSchema)
      setDraft(null)
      set('arguments', template)
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 pt-4">
      {servers && enabled.length === 0 ? (
        <p className="text-xs text-ink-subtle">先在 设置 → MCP 服务 里添加一个服务。</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Select
            aria-label="MCP 服务"
            className="ui-input w-full"
            value={server || NONE}
            options={[
              ...(server ? [] : [{ value: NONE, label: '选择服务' }]),
              ...enabled.map((s) => ({ value: s.id, label: s.name })),
            ]}
            onChange={(v) => {
              if (v === NONE || v === server) return
              set('server', v)
              set('tool', '')
            }}
          />
          <Select
            aria-label="工具"
            className="ui-input w-full"
            value={tool || NONE}
            options={[
              ...(tool ? [] : [{ value: NONE, label: tools.isLoading ? '连接中…' : '选择工具' }]),
              ...(tools.data ?? []).map((t) => ({ value: t.name, label: t.title ?? t.name })),
            ]}
            onChange={(v) => {
              if (v !== NONE && v !== tool) pickTool(v)
            }}
          />
        </div>
      )}
      {tools.error && <p className="text-xs text-danger">{(tools.error as Error).message}</p>}
      {info?.description && (
        <p className="line-clamp-3 text-xs text-ink-muted" title={info.description}>
          {info.description}
        </p>
      )}
      {(server || tool) && (
        <label className="ui-field">
          <span className="ui-label flex items-center">
            <span className="flex-1">参数（JSON）</span>
            {info && (
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet -mr-1.5"
                onClick={() => {
                  setDraft(null)
                  set('arguments', mcpArgumentsTemplate(info.inputSchema))
                }}
              >
                <Icon name="wand" size={12} />
                按说明填模板
              </button>
            )}
          </span>
          <textarea
            aria-label="参数（JSON）"
            className="ui-input ui-scrollbar h-28 w-full py-2 font-mono text-xs"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setDraft(e.target.value)
              // 只有写对了才存进节点，写一半的不污染参数
              if (!jsonProblem(e.target.value)) set('arguments', e.target.value)
            }}
            onBlur={() => {
              if (!problem) setDraft(null)
            }}
          />
          <span className={`ui-help ${problem ? 'text-danger' : ''}`}>
            {problem ?? `字符串里的 ${MCP_INPUT_HOLE} 会换成上游连进来的文字`}
          </span>
        </label>
      )}
    </div>
  )
}
