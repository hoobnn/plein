import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerInput, McpServerView, McpTransport } from '@plein/protocol'
import { newId } from '../ids'

/** 一个外部 MCP 服务的配置；secrets 是 stdio 的环境变量或 http 的请求头，明文存在仅本用户可读的文件里 */
export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  secrets: Record<string, string>
  enabled: boolean
}

export class McpConfigError extends Error {}

/** 外部 MCP 服务的配置，存在数据目录的 mcp-servers.json */
export class McpServerStore {
  private file: string
  private data: McpServerConfig[]

  constructor(dataDir: string) {
    this.file = join(dataDir, 'mcp-servers.json')
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as McpServerConfig[])
      : []
  }

  list(): McpServerConfig[] {
    return this.data.map((c) => ({ ...c, secrets: { ...c.secrets } }))
  }

  get(id: string): McpServerConfig | undefined {
    const c = this.data.find((s) => s.id === id)
    return c && { ...c, secrets: { ...c.secrets } }
  }

  create(input: McpServerInput): McpServerConfig {
    const config = check({
      id: newId('mcp'),
      name: input.name,
      transport: input.transport,
      secrets: {},
      enabled: input.enabled ?? true,
      ...transportOf(input),
    })
    mergeSecrets(config, input.secrets)
    this.data.push(config)
    this.save()
    return config
  }

  update(id: string, input: McpServerInput): McpServerConfig | undefined {
    const i = this.data.findIndex((s) => s.id === id)
    const prev = this.data[i]
    if (!prev) return undefined
    const next = check({
      ...prev,
      name: input.name,
      transport: input.transport,
      enabled: input.enabled ?? prev.enabled,
      command: undefined,
      args: undefined,
      url: undefined,
      ...transportOf(input),
      secrets: { ...prev.secrets },
    })
    mergeSecrets(next, input.secrets)
    this.data[i] = next
    this.save()
    return next
  }

  remove(id: string): boolean {
    const n = this.data.length
    this.data = this.data.filter((s) => s.id !== id)
    if (this.data.length === n) return false
    this.save()
    return true
  }

  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

export function viewOf(c: McpServerConfig): McpServerView {
  return {
    id: c.id,
    name: c.name,
    transport: c.transport,
    ...(c.command ? { command: c.command } : {}),
    ...(c.args?.length ? { args: c.args } : {}),
    ...(c.url ? { url: c.url } : {}),
    secretKeys: Object.keys(c.secrets),
    enabled: c.enabled,
  }
}

function transportOf(input: McpServerInput) {
  return input.transport === 'stdio'
    ? { command: input.command, args: input.args ?? [] }
    : { url: input.url }
}

function check(c: McpServerConfig): McpServerConfig {
  if (c.transport === 'stdio' && !c.command) throw new McpConfigError('请填写要运行的命令')
  if (c.transport === 'http') {
    if (!c.url) throw new McpConfigError('请填写服务地址')
    const { protocol } = new URL(c.url)
    if (protocol !== 'http:' && protocol !== 'https:')
      throw new McpConfigError('服务地址要以 http:// 或 https:// 开头')
  }
  return c
}

function mergeSecrets(c: McpServerConfig, patch: Record<string, string> | undefined) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v) c.secrets[k] = v
    else delete c.secrets[k]
  }
}
