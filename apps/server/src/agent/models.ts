import type { AgentModel, AgentModelCatalog } from '@plein/protocol'
import { childEnv, explain, JsonLines } from './drivers/util'

type Msg = Record<string, unknown>

/** CLI 别名由 Claude Code 解析；列出别名不代表当前账户有访问权限。 */
export const CLAUDE_MODELS: AgentModelCatalog = {
  models: ['sonnet', 'opus', 'haiku'].map((id) => ({
    id,
    title: `Claude ${id[0]!.toUpperCase()}${id.slice(1)}`,
    description: 'Claude Code 的稳定模型别名，由 CLI 解析具体版本；可用性取决于当前账户。',
  })),
}

/** 只 initialize + model/list，不启动 thread 或 turn，不提交生成请求。 */
export async function discoverCodexModels(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000,
): Promise<AgentModelCatalog> {
  let sequence = 1
  const calls = new Map<number, { resolve: (v: Msg) => void; reject: (e: Error) => void }>()
  const proc = new JsonLines(
    bin,
    ['app-server'],
    { cwd, env: childEnv(env, []) },
    (msg) => {
      const id = Number(msg.id)
      const pending = calls.get(id)
      if (!pending) return
      calls.delete(id)
      const error = msg.error as { message?: string } | undefined
      if (error) pending.reject(new Error(error.message ?? 'model/list 失败'))
      else pending.resolve((msg.result ?? {}) as Msg)
    },
    (code, stderr) => {
      const error = new Error(explain('Codex', stderr) ?? `Codex 已退出（代码 ${code}）`)
      for (const pending of calls.values()) pending.reject(error)
      calls.clear()
    },
  )
  const call = (method: string, params: Msg) =>
    new Promise<Msg>((resolve, reject) => {
      if (!proc.alive) return reject(new Error('Codex 已退出'))
      const id = sequence++
      calls.set(id, { resolve, reject })
      proc.write({ id, method, params })
    })
  const timeout = setTimeout(() => {
    for (const pending of calls.values()) pending.reject(new Error('读取 Codex 模型目录超时'))
    calls.clear()
    proc.kill()
  }, timeoutMs)
  try {
    await call('initialize', {
      clientInfo: { name: 'plein', title: 'Plein', version: '0.1.0' },
      capabilities: null,
    })
    proc.write({ method: 'initialized' })
    const models = new Map<string, AgentModel>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let defaultModel: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(result.data)) throw new Error('Codex model/list 返回的目录格式不支持')
      for (const entry of result.data) {
        if (!entry || typeof entry !== 'object') continue
        const raw = entry as Msg
        if (raw.hidden === true) continue
        const id = typeof raw.model === 'string' ? raw.model : raw.id
        if (typeof id !== 'string' || !id) continue
        const efforts = Array.isArray(raw.supportedReasoningEfforts)
          ? raw.supportedReasoningEfforts.flatMap((effort) => {
              const value =
                effort && typeof effort === 'object' ? (effort as Msg).reasoningEffort : null
              return typeof value === 'string' && value ? [value] : []
            })
          : []
        models.set(id, {
          id,
          title: typeof raw.displayName === 'string' ? raw.displayName : id,
          ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
          ...(efforts.length ? { reasoningEfforts: [...new Set(efforts)] } : {}),
          ...(typeof raw.defaultReasoningEffort === 'string' &&
          efforts.includes(raw.defaultReasoningEffort)
            ? { defaultReasoningEffort: raw.defaultReasoningEffort }
            : {}),
        })
        if (raw.isDefault === true) defaultModel = id
      }
      const next = result.nextCursor
      if (next == null || next === '') {
        if (!models.size) throw new Error('Codex 没有返回可用模型')
        return { models: [...models.values()], ...(defaultModel ? { defaultModel } : {}) }
      }
      if (typeof next !== 'string' || cursors.has(next)) throw new Error('Codex 模型目录分页无效')
      cursors.add(next)
      cursor = next
    }
    throw new Error('Codex 模型目录分页超过上限')
  } finally {
    clearTimeout(timeout)
    proc.kill()
  }
}

/** 目录只按 CLI 路径缓存；失败短缓存，刷新复用进行中的请求。 */
export class CodexModelCache {
  private entries = new Map<string, { until: number; result: AgentModelCatalog }>()
  private pending = new Map<string, Promise<AgentModelCatalog>>()
  async get(bin: string, cwd: string, env: NodeJS.ProcessEnv, refresh = false) {
    const active = this.pending.get(bin)
    if (active) return active
    const cached = this.entries.get(bin)
    if (!refresh && cached && cached.until > Date.now()) return cached.result
    const request = discoverCodexModels(bin, cwd, env)
      .catch((error: unknown): AgentModelCatalog => ({
        models: [],
        error: (error as Error).message,
      }))
      .then((result) => {
        this.entries.set(bin, { until: Date.now() + (result.error ? 30_000 : 300_000), result })
        return result
      })
      .finally(() => this.pending.delete(bin))
    this.pending.set(bin, request)
    return request
  }
}
