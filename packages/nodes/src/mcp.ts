import { defineNode, definePlugin, PLUGIN_API_VERSION } from '@plein/plugin-sdk'
import { z } from 'zod'

export const MCP_TOOL_TYPE = 'plein/mcp-tool'

/** 参数里写这个占位，运行时换成上游文本 */
export const MCP_INPUT_HOLE = '{{input}}'

/**
 * MCP 工具节点：调用外部 MCP 服务（在设置里添加）的一个工具。
 * 参数是工具的 JSON 参数，字符串里的 {{input}} 换成上游文本；文字结果从「文本」口出，图片从「图片」口出。
 */
export const mcpToolNode = defineNode({
  type: MCP_TOOL_TYPE,
  version: 1,
  title: 'MCP 工具',
  description: '调用外部 MCP 服务的工具；在设置里添加服务',
  category: 'util',
  execution: 'job',
  inputs: [{ id: 'input', label: '输入', type: 'text', multiple: true }],
  outputs: [
    { id: 'text', label: '文本', type: 'text' },
    { id: 'images', label: '图片', type: 'image' },
  ],
  params: z.object({
    server: z.string().max(100).default('').meta({ title: '服务', widget: 'hidden' }),
    tool: z.string().max(200).default('').meta({ title: '工具', widget: 'hidden' }),
    arguments: z
      .string()
      .max(20_000)
      .default('{}')
      .meta({ title: '参数（JSON）', widget: 'hidden' }),
  }),
})

export const mcpPlugin = definePlugin({
  manifest: {
    id: 'plein/mcp',
    version: '0.1.0',
    name: 'MCP 工具',
    description: '把外部 MCP 服务的工具接到画布上',
    engines: { plein: `^${PLUGIN_API_VERSION}` },
    contributes: { nodes: [`${MCP_TOOL_TYPE}@1`] },
    // 工具返回的图片存进资产库
    permissions: { assets: 'write' },
  },
  nodes: [mcpToolNode],
})

/** 把参数 JSON 里字符串中的 {{input}} 换成上游文本；参数不是 JSON 对象时抛错 */
export function mcpArguments(raw: string, input: string | undefined): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw.trim() || '{}')
  } catch {
    throw new Error('参数不是有效的 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('参数要是一个 JSON 对象，如 {"query": "{{input}}"}')
  const fill = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.split(MCP_INPUT_HOLE).join(input ?? '')
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v
  return fill(value) as Record<string, unknown>
}

/** 按工具的参数说明生成一份参数模板：必填的文字参数填 {{input}}，其余按类型给空值 */
export function mcpArgumentsTemplate(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown; default?: unknown }>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  let holed = false
  const out: Record<string, unknown> = {}
  for (const [key, p] of Object.entries(props)) {
    if (!required.has(key) && p.default === undefined) continue
    if (p.default !== undefined) out[key] = p.default
    else if (p.type === 'string' && !holed) {
      out[key] = MCP_INPUT_HOLE
      holed = true
    } else
      out[key] =
        p.type === 'number' || p.type === 'integer'
          ? 0
          : p.type === 'boolean'
            ? false
            : p.type === 'array'
              ? []
              : p.type === 'object'
                ? {}
                : ''
  }
  return JSON.stringify(out, null, 2)
}
