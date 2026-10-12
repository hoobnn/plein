import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import {
  type AssetRef,
  type Capability,
  type CapabilityInput,
  type ExecutorContext,
  type ModelSpec,
  modelRef,
  type NodeOutputs,
  nodeKey,
  type PluginManifest,
  type PortValue,
  parseModelRef,
  type PollResult,
  portAccepts,
  type ProviderCallResult,
  type ProviderContext,
  ProviderError,
  providerConfigured,
  type ProviderOutput,
  resolveParams,
  type ServerPluginDefinition,
} from '@plein/plugin-sdk'
import type { AssetStore } from '../assets/store'
import type { ProviderConfigStore } from './config-store'
import { Limiter, sleep } from './limiter'
import type { PluginRegistry } from './registry'
import { PermissionError, scopedFetch, scopedSecrets } from './sandbox'

/** 异步任务最长等待时间 */
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_POLL_MS = 2_000

export class NodeRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'NodeRunError'
  }
}

export interface RunNodeOptions {
  type: string
  /** 文档里节点的版本；低于已安装版本时先迁移参数 */
  version: number
  params?: Record<string, unknown>
  inputs?: Record<string, PortValue[]>
  ownerId: string
  signal?: AbortSignal
  onProgress?(fraction: number, message?: string): void
}

const toError = (err: unknown): ProviderError => {
  if (err instanceof ProviderError) return err
  if (err instanceof PermissionError)
    return new ProviderError('invalid_input', err.message, { cause: err })
  if ((err as Error)?.name === 'AbortError')
    return new ProviderError('cancelled', '已取消', { cause: err })
  return new ProviderError('unknown', (err as Error)?.message ?? String(err), { cause: err })
}

/**
 * 插件宿主：把注册表里的声明变成可运行的能力。
 * - Provider 调用归一化：选平台、注入配置与密钥、限流、轮询异步任务、超时与取消、结果文件入库；
 * - 节点执行：参数迁移与校验、输入输出端口校验，执行器只能经过宿主访问模型和资产。
 */
export class PluginHost {
  private limiters = new Map<string, Limiter>()

  constructor(
    readonly registry: PluginRegistry,
    readonly configs: ProviderConfigStore,
    private assets: AssetStore,
    private opts: {
      timeoutMs?: number
      log?: (plugin: string, message: string, data?: unknown) => void
    } = {},
  ) {}

  load(plugins: ServerPluginDefinition[], builtin: boolean) {
    for (const p of plugins) {
      const entry = this.registry.register(p, { builtin })
      if (entry.status === 'error') this.log(entry.manifest.id, `加载失败：${entry.error}`)
    }
  }

  // ── Provider ──────────────────────────────────────

  /** 已启用平台中支持某能力的模型 */
  models(capability: Capability): Array<ModelSpec & { ref: string; provider: string }> {
    const out: Array<ModelSpec & { ref: string; provider: string }> = []
    for (const [id, { def }] of this.registry.providers) {
      if (!this.configs.get(id).enabled) continue
      for (const m of def.models) {
        if (m.capabilities.includes(capability))
          out.push({ ...m, ref: modelRef(id, m.id), provider: id })
      }
    }
    return out
  }

  /** 测试连接：校验配置与密钥；没有 test 方法的平台只校验配置 */
  async testProvider(id: string, ownerId: string, signal?: AbortSignal) {
    const entry = this.registry.providers.get(id)
    if (!entry) throw new ProviderError('invalid_input', `平台 ${id} 未安装`)
    const ctx = this.providerContext(id, ownerId, signal ?? new AbortController().signal, {
      requireEnabled: false,
    })
    try {
      await entry.def.test?.(ctx)
    } catch (err) {
      throw toError(err)
    }
  }

  /** 调用模型能力；文件类结果下载后存入调用者的资产库 */
  async call<C extends Capability>(
    capability: C,
    ref: string,
    input: CapabilityInput<C>,
    opts: { ownerId: string; signal?: AbortSignal; onProgress?: (p: number) => void },
  ): Promise<ProviderCallResult> {
    const parsed = parseModelRef(ref)
    if (!parsed) throw new ProviderError('invalid_input', `模型引用格式不正确：${ref}`)
    const entry = this.registry.providers.get(parsed.provider)
    if (!entry) throw new ProviderError('unavailable', `平台 ${parsed.provider} 未安装`)
    const model = entry.def.models.find((m) => m.id === parsed.model)
    if (!model)
      throw new ProviderError('invalid_input', `平台 ${entry.def.title} 没有模型 ${parsed.model}`)
    if (!model.capabilities.includes(capability)) {
      throw new ProviderError('invalid_input', `模型 ${model.title} 不支持 ${capability}`)
    }

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const ctx = this.providerContext(parsed.provider, opts.ownerId, signal, {
      requireEnabled: true,
    })
    const { def } = entry
    const limiter = this.limiter(parsed.provider, def.limits)

    try {
      const outputs = await limiter.run(async () => {
        const submitted = await def.submit({ capability, model: parsed.model, input }, ctx)
        if (submitted.state === 'succeeded') return submitted
        if (!def.poll)
          throw new ProviderError('unknown', `平台 ${def.title} 返回了异步任务但没有实现 poll`)
        let wait = submitted.pollAfterMs ?? DEFAULT_POLL_MS
        try {
          for (;;) {
            await sleep(wait, signal)
            const r: PollResult = await def.poll(submitted.remoteId, ctx)
            if (r.state === 'succeeded') return r
            if (r.state === 'failed') {
              throw new ProviderError(r.error.code, r.error.message, {
                retryable: r.error.retryable,
              })
            }
            if (r.progress !== undefined) opts.onProgress?.(r.progress)
            wait = r.pollAfterMs ?? DEFAULT_POLL_MS
          }
        } catch (err) {
          // 取消或超时：通知平台取消远端任务（尽力而为）
          if (signal.aborted && def.cancel) {
            // 生成的 signal 已中止；取消请求必须使用独立、有限时长的上下文。
            const cancelCtx = this.providerContext(
              parsed.provider,
              opts.ownerId,
              AbortSignal.timeout(10_000),
              {
                requireEnabled: false,
              },
            )
            await def.cancel(submitted.remoteId, cancelCtx).catch(() => {})
          }
          throw err
        }
      }, signal)
      const assets = await this.storeOutputs(parsed.provider, outputs.outputs, opts.ownerId, signal)
      return { outputs: outputs.outputs, assets, usage: outputs.usage }
    } catch (err) {
      if (timeout.aborted && !opts.signal?.aborted) throw new ProviderError('timeout', '任务超时')
      throw toError(err)
    }
  }

  private providerContext(
    id: string,
    ownerId: string,
    signal: AbortSignal,
    opts: { requireEnabled: boolean },
  ): ProviderContext {
    const { def, plugin } = this.registry.providers.get(id)!
    const manifest = this.manifest(plugin)
    const config = this.configs.get(id)
    if (opts.requireEnabled && !config.enabled)
      throw new ProviderError('unavailable', `平台 ${def.title} 未启用`)
    const settings = def.settings.safeParse(config.settings)
    if (!settings.success)
      throw new ProviderError(
        'invalid_input',
        `平台 ${def.title} 的设置不正确：${settings.error.message}`,
      )
    for (const s of def.secrets) {
      if (s.required && !config.secrets[s.name])
        throw new ProviderError('auth', `平台 ${def.title} 缺少 ${s.title}`)
    }
    if (!providerConfigured(def, config.secrets))
      throw new ProviderError('auth', `平台 ${def.title} 缺少一组完整的鉴权密钥`)
    const fetchScoped = scopedFetch(manifest)
    return {
      settings: settings.data,
      secret: scopedSecrets(manifest, config.secrets),
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        fetchScoped(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        })) as typeof fetch,
      signal,
      log: (message, data) => this.log(plugin, message, data),
      files: { read: (ref) => this.readAsset(manifest, ownerId, ref) },
    }
  }

  private async storeOutputs(
    provider: string,
    outputs: ProviderOutput[],
    ownerId: string,
    signal: AbortSignal,
  ) {
    const manifest = this.manifest(this.registry.providers.get(provider)!.plugin)
    const refs: AssetRef[] = []
    for (const out of outputs) {
      if (out.type !== 'file') continue
      let body: Readable
      if (out.data) body = Readable.from([Buffer.from(out.data)])
      else if (out.url) {
        // 结果文件同样只能从声明过的域名下载
        const res = await scopedFetch(manifest)(out.url, { signal })
        if (!res.ok || !res.body)
          throw new ProviderError('unavailable', `下载结果失败：HTTP ${res.status}`)
        body = Readable.fromWeb(res.body as never)
      } else throw new ProviderError('unknown', '平台返回的文件既没有 url 也没有 data')
      const asset = await this.assets.ingest(ownerId, body, {
        mime: out.mime,
        name: out.name ?? `${out.kind}`,
      })
      refs.push({ assetId: asset.id, kind: out.kind, mime: asset.mime })
    }
    return refs
  }

  private limiter(id: string, limits?: { concurrency?: number; requestsPerMinute?: number }) {
    let l = this.limiters.get(id)
    if (!l) {
      l = new Limiter(
        limits?.concurrency ?? 4,
        limits?.requestsPerMinute ?? Number.POSITIVE_INFINITY,
      )
      this.limiters.set(id, l)
    }
    return l
  }

  // ── 节点执行 ──────────────────────────────────────

  async runNode(opts: RunNodeOptions): Promise<NodeOutputs> {
    const node = this.registry.latestNode(opts.type)
    if (!node) throw new NodeRunError('not_installed', `节点 ${opts.type} 未安装`)
    const key = nodeKey(node.def.type, node.def.version)
    const executor = this.registry.executors.get(key)
    if (!executor) throw new NodeRunError('not_executable', `节点 ${node.def.title} 没有执行器`)
    let params: Record<string, unknown>
    try {
      params = resolveParams(node.def, opts.params, opts.version)
    } catch (err) {
      throw new NodeRunError('invalid_params', `参数不正确：${(err as Error).message}`)
    }
    const inputs = opts.inputs ?? {}
    for (const port of node.def.inputs) {
      const values = inputs[port.id] ?? []
      if (port.required && values.length === 0)
        throw new NodeRunError('missing_input', `缺少输入：${port.label}`)
      if (!port.multiple && values.length > 1)
        throw new NodeRunError('invalid_input', `输入 ${port.label} 只能连一个`)
      for (const v of values) {
        if (!portAccepts(port.type, v.type))
          throw new NodeRunError('invalid_input', `输入 ${port.label} 不接受 ${v.type}`)
      }
    }

    const manifest = this.manifest(executor.plugin)
    const signal = opts.signal ?? new AbortController().signal
    const ctx: ExecutorContext = {
      params,
      inputs,
      signal,
      progress: (f, m) => opts.onProgress?.(Math.min(1, Math.max(0, f)), m),
      log: (message, data) => this.log(executor.plugin, message, data),
      providers: {
        call: (capability, model, input) =>
          this.call(capability, model, input, {
            ownerId: opts.ownerId,
            signal,
            onProgress: (p) => opts.onProgress?.(p),
          }),
        models: (capability) => this.models(capability),
      },
      assets: {
        put: async (file) => {
          if (manifest.permissions.assets !== 'write')
            throw new PermissionError(`插件 ${manifest.id} 没有写资产的权限`)
          const a = await this.assets.ingest(
            opts.ownerId,
            Readable.from([Buffer.from(file.data)]),
            {
              mime: file.mime,
              name: file.name ?? 'file',
            },
          )
          return { assetId: a.id, kind: a.kind, mime: a.mime }
        },
        read: (ref) => this.readAsset(manifest, opts.ownerId, ref),
      },
    }

    let outputs: NodeOutputs
    try {
      outputs = await executor.def.run(ctx)
    } catch (err) {
      if (err instanceof NodeRunError) throw err
      const e = toError(err)
      throw new NodeRunError(e.code, e.message, e.retryable)
    }
    for (const [port, values] of Object.entries(outputs)) {
      const spec = node.def.outputs.find((p) => p.id === port)
      if (!spec) throw new NodeRunError('invalid_output', `执行器输出了未声明的端口 ${port}`)
      for (const v of values) {
        if (!portAccepts(spec.type, v.type))
          throw new NodeRunError('invalid_output', `输出 ${spec.label} 不应为 ${v.type}`)
      }
    }
    return outputs
  }

  // ── 内部 ──────────────────────────────────────────

  private async readAsset(manifest: PluginManifest, ownerId: string, ref: AssetRef) {
    if (manifest.permissions.assets === 'none')
      throw new PermissionError(`插件 ${manifest.id} 没有读资产的权限`)
    const asset = this.assets.get(ownerId, ref.assetId)
    if (!asset) throw new ProviderError('invalid_input', `资产 ${ref.assetId} 不存在`)
    return {
      data: new Uint8Array(await readFile(this.assets.originalPath(asset.id))),
      mime: asset.mime,
    }
  }

  private manifest(plugin: string): PluginManifest {
    return this.registry.plugin(plugin)!.manifest
  }

  private log(plugin: string, message: string, data?: unknown) {
    if (this.opts.log) this.opts.log(plugin, message, data)
    else console.log(`[plugin ${plugin}] ${message}`, data ?? '')
  }
}
