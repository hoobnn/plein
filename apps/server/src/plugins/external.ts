import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { stableStringify } from '@plein/flow'
import {
  type AssetRef,
  Capability,
  type ExecutorDefinition,
  type ModelSpec,
  type NodeDefinition,
  type NodeOutputs,
  PluginDescriptor,
  PluginManifest,
  type PortValue,
  type PromptPresetDefinition,
  type ProviderContext,
  type ProviderDefinition,
  RPC_MAX_BYTES,
  type RpcFetchRequest,
  type RpcFetchResponse,
  type ServerPluginDefinition,
  type TemplateDefinition,
} from '@plein/plugin-sdk'
import type { LocalPluginInfo } from '@plein/protocol'
import { z } from 'zod'
import type { PluginHost } from './host'
import { PluginProcess } from './process'

/** 声明大小上限：插件报上来的节点、平台、模板不该有这么多 */
const DESCRIPTOR_MAX = 1024 * 1024
/** 启动和报声明的时间 */
const DESCRIBE_TIMEOUT_MS = 15_000
/** 平台的提交、轮询、取消、测试单次最长时间（执行器由任务自己的超时管） */
const PROVIDER_TIMEOUT_MS = 60_000

const MANIFEST = 'plein-plugin.json'

interface Found {
  id: string
  dir: string
  manifest?: PluginManifest
  error?: string
  proc?: PluginProcess
  sandbox?: LocalPluginInfo['sandbox']
}

const fromSchema = (s: Record<string, unknown>) =>
  z.fromJSONSchema(s as Parameters<typeof z.fromJSONSchema>[0]) as unknown as z.ZodObject

const bytesOf = (v: unknown, what: string) => {
  if (!(v instanceof Uint8Array)) throw new Error(`${what}不是字节`)
  if (v.byteLength > RPC_MAX_BYTES) throw new Error(`${what}超过 ${RPC_MAX_BYTES >> 20} MB`)
  return v
}

/** 资产引用：只认宿主发出去过的（输入、调模型的结果、插件自己存的） */
const AssetRefShape = z.object({
  assetId: z.string(),
  kind: z.enum(['image', 'video', 'audio']),
  mime: z.string().optional(),
})

/**
 * 把子进程报上来的声明变回宿主能注册的插件：参数 schema 由 JSON Schema 还原，
 * 执行器和平台的每个方法都转成对子进程的请求，子进程要的服务（联网、资产、调模型）
 * 由宿主按原来的权限裁剪后代办。之后注册、限流、调用记录、取消都走和内置插件一样的路。
 */
export function proxyPlugin(desc: PluginDescriptor, proc: PluginProcess): ServerPluginDefinition {
  const manifest = PluginManifest.parse(desc.manifest)
  if (desc.elements) throw new Error('第三方插件暂不支持自定义元素类型')
  if (desc.capabilities) throw new Error('第三方插件暂不支持能力（⌘K / 智能体操作）')
  const nodes = desc.nodes.map((n) => {
    if (n.hasMigrate) throw new Error(`节点 ${n.type} 声明了 migrate，第三方插件暂不支持`)
    if (n.hasApplyOutputs) throw new Error(`节点 ${n.type} 声明了 applyOutputs，第三方插件暂不支持`)
    const { paramsSchema, hasMigrate: _m, hasApplyOutputs: _a, ...rest } = n
    return { ...rest, params: fromSchema(paramsSchema) } as unknown as NodeDefinition
  })
  const byKey = new Map(nodes.map((n) => [`${n.type}@${n.version}`, n]))

  const executors: ExecutorDefinition[] = desc.executors.map((key) => {
    const node = byKey.get(key)
    if (!node) throw new Error(`执行器 ${key} 对应的节点不是本插件声明的`)
    return {
      node,
      run: async (ctx) => {
        const known = new Set<string>()
        const remember = (refs: AssetRef[]) => {
          for (const r of refs) known.add(r.assetId)
        }
        for (const list of Object.values(ctx.inputs))
          for (const v of list) if ('assetId' in v) known.add(v.assetId)
        // ctx.providers.models 是同步接口：把各能力的可用模型一次带过去。
        // 模型的 options 是 zod schema（带函数），进程间传不了，换成 JSON Schema
        const models = Object.fromEntries(
          Capability.options.map((cap) => [
            cap,
            ctx.providers.models(cap).map(({ options, ...m }) => ({
              ...m,
              ...(options
                ? {
                    optionsSchema: z.toJSONSchema(options, { io: 'input', unrepresentable: 'any' }),
                  }
                : {}),
            })),
          ]),
        )
        const out = await proc.request<NodeOutputs>(
          'execute',
          {
            node: key,
            params: structuredClone(ctx.params),
            inputs: structuredClone(ctx.inputs),
            models,
          },
          {
            signal: ctx.signal,
            note: (method, p) => {
              const v = p as { fraction?: number; message?: string; data?: unknown }
              if (method === 'progress' && typeof v.fraction === 'number')
                ctx.progress(v.fraction, typeof v.message === 'string' ? v.message : undefined)
              if (method === 'log' && typeof v.message === 'string') ctx.log(v.message)
            },
            handler: async (method, p) => {
              if (method === 'providers.call') {
                const { capability, model, input } = p as {
                  capability: never
                  model: string
                  input: never
                }
                const r = await ctx.providers.call(capability, String(model), input)
                remember(r.assets)
                return r
              }
              if (method === 'assets.put') {
                const f = p as { data: unknown; mime: unknown; name?: unknown }
                const ref = await ctx.assets.put({
                  data: bytesOf(f.data, '要存的文件'),
                  mime: String(f.mime),
                  ...(typeof f.name === 'string' ? { name: f.name } : {}),
                })
                remember([ref])
                return ref
              }
              if (method === 'assets.read') return ctx.assets.read(AssetRefShape.parse(p))
              throw new Error(`执行器不能用 ${method}`)
            },
          },
        )
        if (!out || typeof out !== 'object') throw new Error('插件返回的结果格式不对')
        for (const values of Object.values(out)) {
          if (!Array.isArray(values)) throw new Error('插件返回的结果格式不对')
          for (const v of values as PortValue[]) {
            if (v && typeof v === 'object' && 'assetId' in v && !known.has(v.assetId))
              throw new Error(`插件返回了不是这次运行得到的资产 ${v.assetId}`)
          }
        }
        return out
      },
    }
  })

  const providers: ProviderDefinition[] = desc.providers.map((p) => {
    const { settingsSchema, models, has, ...rest } = p
    const op =
      (name: 'submit' | 'poll' | 'cancel' | 'test' | 'lookup') =>
      (ctx: ProviderContext, arg?: unknown) =>
        proc.request(
          'provider',
          {
            provider: p.id,
            op: name,
            arg,
            settings: ctx.settings,
            // 只给这个平台声明过的密钥（宿主的 ctx.secret 本身也按清单裁剪过）
            secrets: Object.fromEntries(
              (p.secrets as Array<{ name: string }>).flatMap((s) => {
                const v = ctx.secret(s.name)
                return v ? [[s.name, v]] : []
              }),
            ),
            ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
          },
          {
            signal: ctx.signal,
            timeoutMs: PROVIDER_TIMEOUT_MS,
            note: (method, n) => {
              const v = n as { message?: unknown }
              if (method === 'log' && typeof v.message === 'string') ctx.log(v.message)
            },
            handler: async (method, a) => {
              if (method === 'fetch') {
                const r = a as RpcFetchRequest
                const res = await ctx.fetch(String(r.url), {
                  method: String(r.method),
                  headers: Array.isArray(r.headers) ? r.headers : [],
                  ...(r.body
                    ? { body: bytesOf(r.body, '请求体') as unknown as RequestInit['body'] }
                    : {}),
                })
                const body = new Uint8Array(await res.arrayBuffer())
                bytesOf(body, '响应')
                return {
                  status: res.status,
                  statusText: res.statusText,
                  headers: [...res.headers],
                  body,
                } satisfies RpcFetchResponse
              }
              if (method === 'files.read') return ctx.files.read(AssetRefShape.parse(a))
              throw new Error(`平台不能用 ${method}`)
            },
          },
        )
    return {
      ...rest,
      settings: fromSchema(settingsSchema),
      models: models.map(({ optionsSchema, ...m }) => ({
        ...m,
        ...(optionsSchema ? { options: fromSchema(optionsSchema) } : {}),
      })) as unknown as ModelSpec[],
      submit: (req: unknown, ctx: ProviderContext) => op('submit')(ctx, req),
      ...(has.poll ? { poll: (id: string, ctx: ProviderContext) => op('poll')(ctx, id) } : {}),
      ...(has.cancel
        ? { cancel: (id: string, ctx: ProviderContext) => op('cancel')(ctx, id) }
        : {}),
      ...(has.test ? { test: (ctx: ProviderContext) => op('test')(ctx) } : {}),
      ...(has.lookup
        ? { lookup: (key: string, ctx: ProviderContext) => op('lookup')(ctx, key) }
        : {}),
    } as unknown as ProviderDefinition
  })

  return {
    plugin: {
      manifest,
      nodes,
      templates: desc.templates as TemplateDefinition[],
      prompts: desc.prompts as PromptPresetDefinition[],
      elements: [],
    },
    providers,
    executors,
    capabilities: [],
  }
}

/**
 * 本机第三方插件：数据目录 plugins/ 下每个带 plein-plugin.json 的文件夹是一个插件。
 * 默认不启用；在设置里看过它要的权限后打开，才拉起子进程、报声明、注册进目录。
 */
export class ExternalPlugins {
  private found = new Map<string, Found>()
  private enabled: Set<string>

  constructor(
    private host: PluginHost,
    readonly root: string,
    private stateFile: string,
  ) {
    let saved: unknown
    try {
      saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch {
      saved = null
    }
    const list = (saved as { enabled?: unknown } | null)?.enabled
    this.enabled = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [])
  }

  /** 扫描目录并启动已启用的插件 */
  async init() {
    this.scan()
    for (const f of this.found.values())
      if (this.enabled.has(f.id) && f.manifest) await this.start(f)
  }

  /** 重新读目录：新放进来的出现，删掉的（没在运行的）消失；已在运行的不动 */
  scan() {
    const seen = new Set<string>()
    const previousIds = new Map([...this.found.values()].map((f) => [f.dir, f.id]))
    const dirs = existsSync(this.root)
      ? readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory())
      : []
    for (const d of dirs) {
      const dir = resolve(this.root, d.name)
      const file = join(dir, MANIFEST)
      if (!existsSync(file)) continue
      let manifest: PluginManifest | undefined
      let error: string | undefined
      try {
        const parsed = PluginManifest.safeParse(JSON.parse(readFileSync(file, 'utf8')))
        if (!parsed.success) error = `清单不对：${parsed.error.issues[0]?.message ?? ''}`
        else if (!parsed.data.main?.server) error = '清单里没有 main.server（服务端入口）'
        else manifest = parsed.data
      } catch (err) {
        error = `清单读不出来：${(err as Error).message}`
      }
      // 已知插件的坏清单不能把身份换成目录名，否则重载后无法再停用或恢复。
      const id = manifest?.id ?? previousIds.get(dir) ?? d.name
      seen.add(id)
      const prev = this.found.get(id)
      if (prev?.proc) continue
      if (prev && prev.dir !== dir) {
        this.found.set(id, { ...prev, error: `和 ${prev.dir} 里的插件 id 重复` })
        continue
      }
      this.found.set(id, { id, dir, manifest, error })
    }
    for (const [id, f] of this.found) if (!seen.has(id) && !f.proc) this.found.delete(id)
  }

  private async start(f: Found) {
    const manifest = f.manifest!
    if (this.host.registry.plugin(f.id)?.builtin) {
      f.error = '和内置插件 id 重复'
      return
    }
    const entry = resolve(f.dir, manifest.main!.server!)
    if (!entry.startsWith(f.dir + sep) || !existsSync(entry)) {
      f.error = `找不到服务端入口 ${manifest.main!.server}`
      return
    }
    const proc = new PluginProcess(f.id, f.dir, entry, (m) => console.log(`[plugin ${f.id}] ${m}`))
    try {
      const raw = await proc.request<unknown>('describe', null, { timeoutMs: DESCRIBE_TIMEOUT_MS })
      if (JSON.stringify(raw).length > DESCRIPTOR_MAX) throw new Error('插件声明太大')
      const desc = PluginDescriptor.parse(raw)
      if (stableStringify(PluginManifest.parse(desc.manifest)) !== stableStringify(manifest))
        throw new Error('入口报上来的清单与已确认的磁盘清单不一致，请核对版本、贡献和权限')
      const sp = proxyPlugin(desc, proc)
      if (sp.plugin.manifest.id !== manifest.id) throw new Error('入口报上来的 id 和清单不一致')
      const entryInfo = this.host.registry.register(sp, { builtin: false })
      if (entryInfo.status === 'error') {
        this.host.registry.unregister(f.id)
        throw new Error(entryInfo.error)
      }
      f.proc = proc
      f.sandbox = desc.sandbox
      f.error = undefined
    } catch (err) {
      proc.kill()
      f.error = `加载失败：${(err as Error).message}`
    }
  }

  private stop(f: Found) {
    if (f.proc) {
      this.host.registry.unregister(f.id)
      f.proc.kill()
      f.proc = undefined
    }
  }

  private save() {
    const part = join(dirname(this.stateFile), `.plugins-state-${randomUUID()}.tmp`)
    try {
      writeFileSync(part, JSON.stringify({ enabled: [...this.enabled] }, null, 2), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      })
      renameSync(part, this.stateFile)
    } finally {
      rmSync(part, { force: true })
    }
  }

  /** 在安装目录发布前清除遗留启用意图，进程此后退出也不会在重启时执行新包。 */
  prepareInstall(id: string) {
    this.scan()
    if (this.found.has(id)) throw new Error('插件 ID 已存在，不会覆盖安装')
    const wasEnabled = this.enabled.has(id)
    this.enabled.delete(id)
    try {
      this.save()
    } catch (error) {
      if (wasEnabled) this.enabled.add(id)
      throw error
    }
  }

  async setEnabled(id: string, on: boolean): Promise<LocalPluginInfo | null> {
    const f = this.found.get(id)
    if (!f) return null
    const wasEnabled = this.enabled.has(id)
    if (on) this.enabled.add(id)
    else this.enabled.delete(id)
    try {
      this.save()
    } catch (error) {
      if (wasEnabled) this.enabled.add(id)
      else this.enabled.delete(id)
      throw error
    }
    this.stop(f)
    if (on && f.manifest) await this.start(f)
    return this.info(f)
  }

  /** 重新加载：结束进程，重读清单和入口 */
  async reload(id: string): Promise<LocalPluginInfo | null> {
    const f = this.found.get(id)
    if (!f) return null
    this.stop(f)
    this.scan()
    const next = this.found.get(id)
    if (!next) return null
    if (this.enabled.has(id) && next.manifest) await this.start(next)
    return this.info(next)
  }

  private info(f: Found): LocalPluginInfo {
    const m = f.manifest
    const broken = f.proc?.broken
    const enabled = this.enabled.has(f.id)
    return {
      id: f.id,
      name: m?.name ?? f.id,
      version: m?.version ?? '',
      ...(m?.description ? { description: m.description } : {}),
      ...(m?.author ? { author: m.author } : {}),
      dir: f.dir,
      enabled,
      status: f.error || broken ? 'error' : enabled && f.proc ? 'active' : 'disabled',
      ...(f.error || broken ? { error: f.error ?? broken ?? undefined } : {}),
      ...(m ? { permissions: m.permissions, contributes: m.contributes } : {}),
      ...(f.sandbox ? { sandbox: f.sandbox } : {}),
    }
  }

  list(): LocalPluginInfo[] {
    return [...this.found.values()]
      .map((f) => this.info(f))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  close() {
    for (const f of this.found.values()) f.proc?.kill()
  }
}
