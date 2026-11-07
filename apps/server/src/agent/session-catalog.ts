import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind, AgentModelCatalog, AgentSettings, AgentStatus } from '@plein/protocol'
import { builtinModel } from './builtin'
import type { CliEnvironment } from './cli'
import { CLAUDE_MODELS, CodexModelCache } from './models'
import { AgentError, type SessionEnv } from './session-types'

/**
 * 会话可用性：有哪些智能体、哪些模型、设置是否合法。
 * 与会话状态机分开：本机 CLI 的探测与模型目录查询都不碰会话数据。
 */
export class SessionCatalog {
  private modelCache = new CodexModelCache()

  constructor(
    private env: SessionEnv,
    /** 找本机 CLI；测试里换成假的 */
    private detect: (refresh?: boolean) => Promise<CliEnvironment>,
  ) {}

  async status(refresh = false): Promise<AgentStatus> {
    const model = builtinModel(this.env.deps.host)
    const builtin = {
      id: 'builtin' as const,
      name: '内置',
      available: !!model,
      ...(model ? { model: model.title } : {}),
    }
    // 内置智能体不跑本机程序，哪种部署都能用；CLI 只在本机免登录模式下可用
    if (!this.env.deps.enabled) {
      return model
        ? { enabled: true, agents: [builtin] }
        : {
            enabled: false,
            reason: '启用一个支持工具调用的对话模型后，就能使用内置智能体',
            agents: [builtin],
          }
    }
    const env = await this.detect(refresh)
    return {
      enabled: true,
      agents: [builtin, ...env.agents.map(({ path: _, ...a }) => a)],
    }
  }

  async models(agent: AgentKind, refresh = false): Promise<AgentModelCatalog> {
    if (agent === 'builtin') {
      const host = this.env.deps.host
      const models = host
        .models('text.chat', { agent: true })
        .filter((m) => m.features?.includes('tools'))
      const selected = builtinModel(host)
      // 不同平台常有同名模型（如方舟按量与 Agent Plan），标题带上平台名才分得清
      const providerTitle = (id: string) => host.registry.providers.get(id)?.def.title ?? id
      return {
        models: models.map((m) => ({
          id: m.ref,
          title: `${m.title} · ${providerTitle(m.provider)}`,
        })),
        ...(selected ? { defaultModel: selected.ref } : {}),
      }
    }
    if (!this.env.deps.enabled) throw new AgentError('disabled', '本机智能体未启用')
    if (agent === 'claude') return CLAUDE_MODELS
    const env = await this.detect(refresh)
    const cli = env.agents.find((candidate) => candidate.id === 'codex')
    if (!cli?.path) return { models: [], error: '本机没有找到 Codex' }
    const cwd = join(this.env.deps.dataDir, 'agent')
    mkdirSync(cwd, { recursive: true })
    return this.modelCache.get(cli.path, cwd, { ...process.env, PATH: env.path }, refresh)
  }

  async validateSettings(agent: AgentKind, settings: AgentSettings): Promise<AgentSettings> {
    if (!settings.model && !settings.reasoningEffort) return {}
    if (settings.reasoningEffort && !settings.model)
      throw new AgentError('invalid_input', '请先选择具体模型再设置推理强度')
    const catalog = await this.models(agent)
    if (catalog.error) throw new AgentError('not_ready', catalog.error)
    const model = catalog.models.find((m) => m.id === (settings.model ?? catalog.defaultModel))
    if (!model) throw new AgentError('invalid_input', '所选模型已不可用，请刷新模型列表后重新选择')
    if (settings.reasoningEffort && !model.reasoningEfforts?.includes(settings.reasoningEffort))
      throw new AgentError('invalid_input', '所选模型不支持这个推理强度')
    // Codex turn overrides persist as thread defaults. Always resolve the selected model's
    // declared default effort rather than inheriting another model's previous effort.
    return {
      ...settings,
      ...(agent === 'codex'
        ? {
            model: model.id,
            ...((settings.reasoningEffort ?? model.defaultReasoningEffort)
              ? { reasoningEffort: settings.reasoningEffort ?? model.defaultReasoningEffort }
              : {}),
          }
        : {}),
    }
  }
}
