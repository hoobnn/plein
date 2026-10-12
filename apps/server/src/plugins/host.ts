import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import {
  type AssetRef,
  type Capability,
  type CapabilityInput,
  type ComposeSpec,
  type ExecutorContext,
  type MediaInfo,
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
import { stableStringify } from '@plein/flow'
import { composeVideo } from '../assets/compose'
import { hasFfmpeg, probeMedia } from '../assets/media'
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

/**
 * 一次节点运行内的模型调用记录。服务重启后重新执行同一个任务时：
 * 已完成的调用直接返回记录的结果，已提交的异步任务接着轮询，都不会重复提交（也就不重复计费）。
 */
export type CallRecord =
  | { state: 'pending'; remoteId: string }
  | { state: 'done'; result: ProviderCallResult }

/**
 * 服务退出时中止运行用的 reason：不取消远端任务、不清调用记录，重启后接着轮询
 */
export const SHUTDOWN = Symbol('plein.shutdown')

export interface CallJournal {
  get(key: string): CallRecord | undefined
  set(key: string, record: CallRecord): void
  delete(key: string): void
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
  journal?: CallJournal
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
    opts: {
      ownerId: string
      signal?: AbortSignal
      onProgress?: (p: number) => void
      /** 调用记录与这次调用的键，见 CallJournal */
      journal?: { store: CallJournal; key: string }
    },
  ): Promise<ProviderCallResult> {
    const journal = opts.journal
    const recorded = journal?.store.get(journal.key)
    if (recorded?.state === 'done') return recorded.result

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

    // 模型声明不支持种子时不传：节点上残留的种子不该让整次生成失败
    if (model.limits?.seed === false && 'seed' in input) {
      const { seed: _, ...rest } = input as { seed?: number }
      input = rest as typeof input
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
        let remoteId: string
        let wait = DEFAULT_POLL_MS
        if (recorded?.state === 'pending' && def.poll) {
          // 重启前已经提交过：接着轮询，不再提交
          remoteId = recorded.remoteId
          wait = 0
        } else {
          const submitted = await def.submit({ capability, model: parsed.model, input }, ctx)
          if (submitted.state === 'succeeded') return submitted
          if (!def.poll)
            throw new ProviderError('unknown', `平台 ${def.title} 返回了异步任务但没有实现 poll`)
          remoteId = submitted.remoteId
          wait = submitted.pollAfterMs ?? DEFAULT_POLL_MS
          journal?.store.set(journal.key, { state: 'pending', remoteId })
        }
        try {
          for (;;) {
            await sleep(wait, signal)
            const r: PollResult = await def.poll!(remoteId, ctx)
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
          if (signal.aborted && def.cancel && opts.signal?.reason !== SHUTDOWN) {
            // 生成的 signal 已中止；取消请求必须使用独立、有限时长的上下文。
            const cancelCtx = this.providerContext(
              parsed.provider,
              opts.ownerId,
              AbortSignal.timeout(10_000),
              {
                requireEnabled: false,
              },
            )
            await def.cancel(remoteId, cancelCtx).catch(() => {})
          }
          throw err
        }
      }, signal)
      const assets = await this.storeOutputs(parsed.provider, outputs.outputs, opts.ownerId, signal)
      const result: ProviderCallResult = { outputs: outputs.outputs, assets, usage: outputs.usage }
      journal?.store.set(journal.key, { state: 'done', result })
      return result
    } catch (err) {
      // 失败的远端任务不能再接着轮询，重跑时重新提交；服务退出时保留，重启后续跑
      if (opts.signal?.reason !== SHUTDOWN) journal?.store.delete(journal.key)
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
    // 同样的调用可能有意发多次（例如一次要多张候选图），按出现次序区分
    const seen = new Map<string, number>()
    const callKey = (capability: string, model: string, input: unknown) => {
      const hash = createHash('sha256')
        .update(stableStringify({ capability, model, input }))
        .digest('hex')
      const n = seen.get(hash) ?? 0
      seen.set(hash, n + 1)
      return `${hash}#${n}`
    }
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
            journal: opts.journal && {
              store: opts.journal,
              key: callKey(capability, model, input),
            },
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
      media: {
        probe: (ref) => this.probe(manifest, opts.ownerId, ref),
        compose: (spec) =>
          this.compose(manifest, opts.ownerId, spec, signal, (f) =>
            opts.onProgress?.(Math.min(1, Math.max(0, f))),
          ),
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

  /** 插件有 media 权限、ffmpeg 可用时，返回资产原文件路径 */
  private async mediaPath(manifest: PluginManifest, ownerId: string, ref: AssetRef) {
    if (!manifest.permissions.media)
      throw new PermissionError(`插件 ${manifest.id} 没有处理媒体的权限`)
    if (!(await hasFfmpeg()))
      throw new ProviderError('unavailable', '没有找到 ffmpeg，无法处理视频和音频', {
        retryable: false,
      })
    const asset = this.assets.get(ownerId, ref.assetId)
    if (!asset) throw new ProviderError('invalid_input', `资产 ${ref.assetId} 不存在`)
    return this.assets.originalPath(asset.id)
  }

  private async probe(
    manifest: PluginManifest,
    ownerId: string,
    ref: AssetRef,
  ): Promise<MediaInfo> {
    return probeMedia(await this.mediaPath(manifest, ownerId, ref))
  }

  private async compose(
    manifest: PluginManifest,
    ownerId: string,
    spec: ComposeSpec,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<AssetRef> {
    const clips = await Promise.all(
      spec.clips.map((c) => this.mediaPath(manifest, ownerId, c.asset)),
    )
    const audio = await Promise.all(
      spec.audio.map((a) => this.mediaPath(manifest, ownerId, a.asset)),
    )
    const infos = await Promise.all(clips.map((f) => probeMedia(f)))
    const missing = infos.findIndex((i) => !i.hasVideo)
    if (missing >= 0) throw new ProviderError('invalid_input', `第 ${missing + 1} 段不是视频`)
    const dir = await this.assets.tempDir()
    try {
      const { file } = await composeVideo(spec, { clips, audio }, { clips: infos }, dir, {
        signal,
        onProgress,
      })
      const a = await this.assets.ingest(ownerId, createReadStream(file), {
        mime: 'video/mp4',
        name: `${spec.name ?? '成片'}.mp4`,
      })
      return { assetId: a.id, kind: a.kind, mime: a.mime }
    } catch (err) {
      if (signal.aborted) throw new ProviderError('cancelled', '已取消')
      if (err instanceof ProviderError) throw err
      throw new ProviderError('unknown', (err as Error).message)
    } finally {
      await rm(dir, { recursive: true, force: true })
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
