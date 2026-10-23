import { createHash } from 'node:crypto'
import type { AgentSkill } from '@plein/protocol'
import { childEnv, explain, JsonLines } from './drivers/util'

type Msg = Record<string, unknown>
export interface CodexSkills {
  skills: AgentSkill[]
  warnings: string[]
  error?: string
}

/** 只握手并执行目录/配置 RPC；发现技能不能产生 thread 或 turn。 */
export async function codexSkillRpc(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  method: 'skills/list' | 'skills/config/write',
  params: Msg,
  timeoutMs = 8000,
): Promise<Msg> {
  let sequence = 1
  const calls = new Map<number, { resolve: (v: Msg) => void; reject: (e: Error) => void }>()
  const reject = (message: string) => {
    for (const pending of calls.values()) pending.reject(new Error(message))
    calls.clear()
  }
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
      if (error) pending.reject(new Error(error.message ?? `${method} 失败`))
      else if (!msg.result || typeof msg.result !== 'object')
        pending.reject(new Error(`${method} 返回的格式不支持`))
      else pending.resolve(msg.result as Msg)
    },
    (code, stderr) => reject(explain('Codex', stderr) ?? `Codex 已退出（代码 ${code}）`),
  )
  const call = (rpc: string, input: Msg) =>
    new Promise<Msg>((resolve, fail) => {
      if (!proc.alive) return fail(new Error('Codex 已退出'))
      const id = sequence++
      calls.set(id, { resolve, reject: fail })
      proc.write({ id, method: rpc, params: input })
    })
  const timeout = setTimeout(() => {
    reject('读取或修改 Codex 技能超时')
    proc.kill()
  }, timeoutMs)
  try {
    await call('initialize', {
      clientInfo: { name: 'plein', title: 'Plein', version: '0.1.0' },
      capabilities: null,
    })
    proc.write({ method: 'initialized' })
    return await call(method, params)
  } finally {
    clearTimeout(timeout)
    proc.kill()
  }
}

export const codexSkillId = (path: string) =>
  `codex:${createHash('sha256').update(path).digest('hex').slice(0, 40)}`

export async function discoverCodexSkills(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000,
): Promise<CodexSkills> {
  const result = await codexSkillRpc(
    bin,
    cwd,
    env,
    'skills/list',
    {
      cwds: [cwd],
      forceReload: true,
    },
    timeoutMs,
  )
  if (!Array.isArray(result.data)) throw new Error('Codex skills/list 返回的目录格式不支持')
  if (result.data.length > 20) throw new Error('Codex 技能目录分组超过上限')
  const skills = new Map<string, AgentSkill>()
  const warnings: string[] = []
  let foundCwd = false
  for (const row of result.data) {
    if (!row || typeof row !== 'object') throw new Error('Codex 技能目录条目格式不支持')
    const entry = row as Msg
    if (entry.cwd !== cwd) continue
    foundCwd = true
    if (!Array.isArray(entry.skills)) throw new Error('Codex 技能目录缺少 skills 列表')
    if (Array.isArray(entry.errors) && entry.errors.length)
      warnings.push(`Codex 有 ${entry.errors.length} 个技能未能加载，请在 CLI 中检查技能目录。`)
    if (entry.skills.length > 500) throw new Error('Codex 技能目录超过 500 项上限')
    for (const value of entry.skills) {
      const raw = value && typeof value === 'object' ? (value as Msg) : null
      if (
        !raw ||
        typeof raw.name !== 'string' ||
        !raw.name ||
        raw.name.length > 200 ||
        typeof raw.path !== 'string' ||
        !raw.path ||
        raw.path.length > 4096 ||
        typeof raw.enabled !== 'boolean' ||
        typeof raw.description !== 'string'
      ) {
        warnings.push('Codex 返回了无法识别的技能条目，已跳过。')
        continue
      }
      const ui = raw.interface && typeof raw.interface === 'object' ? (raw.interface as Msg) : {}
      const scope = typeof raw.scope === 'string' ? raw.scope : undefined
      const id = codexSkillId(raw.path)
      skills.set(id, {
        id,
        name: raw.name,
        title: typeof ui.displayName === 'string' && ui.displayName ? ui.displayName : raw.name,
        description:
          typeof ui.shortDescription === 'string' && ui.shortDescription
            ? ui.shortDescription
            : raw.description,
        source: 'codex',
        enabled: raw.enabled,
        selection: 'optional',
        prompt: `使用 ${raw.name} 处理当前画布任务`,
        capabilities: [],
        path: raw.path,
        ...(scope ? { scope } : {}),
        // 系统/管理员/未知来源的技能由上游策略管理，不能假设本机可写。
        canToggle: scope === 'user' || scope === 'repo',
      })
      if (skills.size > 500) throw new Error('Codex 技能目录超过 500 项上限')
    }
  }
  if (!foundCwd) throw new Error('Codex 技能目录没有返回当前工作目录')
  return { skills: [...skills.values()], warnings: [...new Set(warnings)] }
}

/** 按可执行文件与工作目录缓存；失败短缓存，刷新复用进行中的发现。 */
export class CodexSkillCache {
  private entries = new Map<string, { until: number; result: CodexSkills }>()
  private pending = new Map<string, Promise<CodexSkills>>()
  private key(bin: string, cwd: string) {
    return `${bin}\0${cwd}`
  }
  invalidate(bin: string, cwd: string) {
    this.entries.delete(this.key(bin, cwd))
  }
  async get(bin: string, cwd: string, env: NodeJS.ProcessEnv, refresh = false) {
    const key = this.key(bin, cwd)
    const active = this.pending.get(key)
    if (active) return active
    const cached = this.entries.get(key)
    if (!refresh && cached && cached.until > Date.now()) return cached.result
    const request = discoverCodexSkills(bin, cwd, env)
      .catch((error: unknown): CodexSkills => ({
        skills: [],
        warnings: [],
        error: (error as Error).message,
      }))
      .then((result) => {
        this.entries.set(key, { until: Date.now() + (result.error ? 30_000 : 300_000), result })
        return result
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }
}
