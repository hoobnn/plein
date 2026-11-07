import { z } from 'zod'
import { defineTool, type McpTool } from './mcp'

/**
 * 内置智能体的工具按需加载：每一步只发核心工具集，其余工具先发现、再用 load_tools 加载。
 * 这样系统指令之外的工具定义不必每步都占上下文；MCP 清单（Claude Code / Codex、对外 MCP）不受影响。
 */

/**
 * 核心工具集，选取标准（以代码里真实存在的工具名为准，缺失的名字会被忽略，由测试守住）：
 * 1. 系统指令「做事方式」里反复用到的核心流程：读画布、读选区与视口、建与改、运行单个节点并查看结果、估价；
 * 2. 全部确认关卡工具：await_approval、propose_plan、update_plan、propose_edit。模型必须能答复 needs_approval 和计划模式，不能依赖先加载；
 * 3. 发现工具：能列出其余工具、扩展操作、节点类型和模型目录；
 * 4. load_tools 本身。
 * 顺序固定不变，发送给模型的清单 = 核心集 + 已加载工具（按加载先后），只追加不重排，利于提示缓存。
 */
export const CORE_TOOLS: readonly string[] = [
  // 读画布与界面状态
  'get_canvas_page',
  'get_canvas',
  'get_element',
  'get_element_field',
  'find_elements',
  'ui_get_selection',
  'ui_get_viewport',
  'ui_focus',
  // 建与改
  'create_node',
  'create_element',
  'update_element',
  'connect',
  'delete_elements',
  // 运行与查看
  'run_node',
  'wait_for_run',
  'view_media',
  'estimate_cost',
  // 确认关卡
  'await_approval',
  'propose_plan',
  'update_plan',
  'propose_edit',
  // 发现
  'list_canvas_capabilities',
  'list_canvas_actions',
  'list_node_types',
  'list_models',
  'load_tools',
]

export const LOAD_TOOLS = 'load_tools'

/** 工具说明的第一句，作为加载结果里的一句话用途 */
const gist = (description: string) => {
  const first = description.split(/[。\n]/)[0]!.trim()
  return first.length > 60 ? `${first.slice(0, 60)}…` : first
}

/** 编辑距离的近似候选由调用方传入（builtin.ts 的 closestTools），这里不重复实现 */
export interface ToolLoader {
  /** 全部可调用工具（不含 load_tools） */
  all: McpTool[]
  /** 已加载工具名，按加载先后；跨轮保留 */
  loaded: string[]
  closest(name: string, names: string[]): string[]
}

/** 把一批名字加入已加载集合（已在核心集或已加载的跳过），返回新加入的 */
export function markLoaded(loader: ToolLoader, names: string[]): string[] {
  const known = new Set(loader.all.map((t) => t.name))
  const have = new Set([...CORE_TOOLS, ...loader.loaded])
  const added: string[] = []
  for (const name of names) {
    if (!known.has(name) || have.has(name)) continue
    have.add(name)
    loader.loaded.push(name)
    added.push(name)
  }
  return added
}

/** 内置智能体专用的 load_tools；不登记进能力注册表，因此不会出现在 MCP 清单里 */
export function loadToolsTool(loader: ToolLoader): McpTool {
  return defineTool({
    name: LOAD_TOOLS,
    title: '加载工具',
    description:
      '加载核心工具之外的工具，加载后从下一步起可直接调用。先用 list_canvas_capabilities 查名字，再把需要的一次性传进来；已加载的不会重复加载。',
    input: z.object({ names: z.array(z.string().min(1)).min(1).max(30) }),
    annotations: { readOnlyHint: true },
    run: ({ names }) => {
      const byName = new Map(loader.all.map((t) => [t.name, t]))
      const unknown = names.filter((n) => !byName.has(n) && n !== LOAD_TOOLS)
      const added = new Set(markLoaded(loader, names))
      const lines = [...new Set(names)]
        .filter((n) => byName.has(n))
        .map((n) => {
          const state = added.has(n) ? '已加载' : '已可用'
          return `- ${n}（${state}）：${gist(byName.get(n)!.description)}`
        })
      const missing = unknown.map(
        (n) => `- 没有工具 ${n}；最接近的有：${loader.closest(n, [...byName.keys()]).join('、')}`,
      )
      const body = [...lines, ...missing].join('\n')
      return {
        content: [
          {
            type: 'text' as const,
            text: lines.length
              ? `${body}\n加载的工具从下一步起可以调用；调用前如不确定参数，用 list_canvas_capabilities 指定 name 查看契约。`
              : body,
          },
        ],
        ...(lines.length ? {} : { isError: true }),
      }
    },
  })
}

/** 本步要发送的工具：核心集（固定顺序）+ 已加载工具（加载先后）；all 须已含 load_tools */
export function selectTools(all: McpTool[], loaded: string[]): McpTool[] {
  const byName = new Map(all.map((t) => [t.name, t]))
  const names = [...CORE_TOOLS, ...loaded.filter((n) => !CORE_TOOLS.includes(n))]
  return names.flatMap((n) => {
    const t = byName.get(n)
    return t ? [t] : []
  })
}

/** 内置智能体的工具集：全部可调用工具（含 load_tools）与本步要发送的子集 */
export function builtinToolset(tools: McpTool[], loaded: string[], closest: ToolLoader['closest']) {
  const loader: ToolLoader = { all: tools, loaded, closest }
  const all = [...tools, loadToolsTool(loader)]
  return { all, loader, send: () => selectTools(all, loaded) }
}
