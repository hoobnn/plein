import { z } from 'zod'
import type { ExecutorContext } from './executor'
import { nodeKey } from './ids'
import type { ProviderContext, ProviderDefinition } from './provider'
import type { ServerPluginDefinition } from './plugin'
import {
  fromRpcError,
  type PluginDescriptor,
  RPC_VERSION,
  type RpcFetchRequest,
  type RpcFetchResponse,
  type RpcMessage,
  toRpcError,
} from './rpc'

/**
 * 第三方插件的入口：插件打包后的服务端文件最后调用 `servePlugin(serverPlugin)`，
 * 宿主在独立子进程里运行它。插件代码不和宿主同进程，联网、密钥、资产、调模型都经宿主代理，
 * 按清单的权限裁剪；子进程的环境变量里没有任何密钥。
 *
 * ```ts
 * import { servePlugin } from '@plein/plugin-sdk/child'
 * servePlugin(defineServerPlugin(plugin, { executors, providers }))
 * ```
 */
/** 用到的 Node 进程接口（SDK 不依赖 @types/node） */
interface ChildProcess {
  send?(message: unknown): boolean
  on(event: 'message', fn: (message: unknown) => void): void
  on(event: 'disconnect', fn: () => void): void
  exit(code: number): never
  permission?: { has(scope: string): boolean }
  allowedNodeEnvironmentFlags?: { has(flag: string): boolean }
}
const proc = () => (globalThis as unknown as { process: ChildProcess }).process

export function servePlugin(sp: ServerPluginDefinition) {
  const process = proc()
  const send = process.send?.bind(process)
  if (!send) throw new Error('servePlugin 要在 plein 宿主启动的子进程里运行')
  const post = (m: RpcMessage) => send(m)

  /** 宿主发来、正在处理的请求：中止信号 */
  const running = new Map<number, AbortController>()
  /** 子进程发给宿主、等回音的请求 */
  const waiting = new Map<number, { ok(v: unknown): void; fail(e: Error): void }>()
  let nextId = 1

  const call = <T>(ctx: number, method: string, params: unknown): Promise<T> =>
    new Promise((ok, fail) => {
      const id = nextId++
      waiting.set(id, { ok: ok as (v: unknown) => void, fail })
      post({ t: 'req', id, method, params, ctx })
    })
  const note = (ctx: number, method: 'progress' | 'log', params: unknown) =>
    post({ t: 'note', method, ctx, params })

  const providers = new Map(sp.providers.map((p) => [p.id, p]))
  const executors = new Map(sp.executors.map((e) => [nodeKey(e.node.type, e.node.version), e]))

  /** ctx.fetch：把请求摊平交给宿主代发，回来的字节还原成 Response */
  const proxyFetch =
    (ctx: number): typeof fetch =>
    async (input, init) => {
      const req = new Request(input, init)
      const body = req.body ? new Uint8Array(await req.arrayBuffer()) : undefined
      const res = await call<RpcFetchResponse>(ctx, 'fetch', {
        url: req.url,
        method: req.method,
        headers: [...req.headers],
        ...(body ? { body } : {}),
      } satisfies RpcFetchRequest)
      const nullBody = [101, 204, 205, 304].includes(res.status)
      return new Response(nullBody ? null : (res.body as unknown as BodyInit), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    }

  const providerCtx = (
    ctx: number,
    signal: AbortSignal,
    p: {
      settings: Record<string, unknown>
      idempotencyKey?: string
      secrets: Record<string, string>
    },
  ): ProviderContext => ({
    settings: p.settings,
    // 宿主只送来清单声明过、且这次调用用得到的密钥
    secret: (name) => p.secrets[name],
    fetch: proxyFetch(ctx),
    signal,
    log: (message, data) => note(ctx, 'log', { message, data }),
    files: { read: (ref) => call(ctx, 'files.read', ref) },
    ...(p.idempotencyKey ? { idempotencyKey: p.idempotencyKey } : {}),
  })

  const unsupported = (what: string) => () => {
    throw new Error(`第三方插件暂不支持 ${what}`)
  }

  const handle = async (id: number, method: string, params: unknown, signal: AbortSignal) => {
    if (method === 'describe') return describe(sp)
    if (method === 'execute') {
      const p = params as {
        node: string
        params: Record<string, unknown>
        inputs: ExecutorContext['inputs']
        models: Record<string, ReturnType<ExecutorContext['providers']['models']>>
      }
      const ex = executors.get(p.node)
      if (!ex) throw new Error(`没有节点 ${p.node} 的执行器`)
      const ctx: ExecutorContext = {
        params: p.params,
        inputs: p.inputs,
        signal,
        progress: (fraction, message) => note(id, 'progress', { fraction, message }),
        log: (message, data) => note(id, 'log', { message, data }),
        providers: {
          call: (capability, model, input) =>
            call(id, 'providers.call', { capability, model, input }),
          models: (capability) => p.models[capability] ?? [],
        },
        assets: {
          put: (file) => call(id, 'assets.put', file),
          read: (ref) => call(id, 'assets.read', ref),
        },
        media: {
          probe: unsupported('ctx.media.probe'),
          compose: unsupported('ctx.media.compose'),
        } as unknown as ExecutorContext['media'],
      }
      return ex.run(ctx)
    }
    if (method === 'provider') {
      const p = params as {
        provider: string
        op: 'submit' | 'poll' | 'cancel' | 'test' | 'lookup'
        arg?: unknown
        settings: Record<string, unknown>
        secrets: Record<string, string>
        idempotencyKey?: string
      }
      const def = providers.get(p.provider) as ProviderDefinition | undefined
      if (!def) throw new Error(`没有平台 ${p.provider}`)
      const ctx = providerCtx(id, signal, p)
      switch (p.op) {
        case 'submit':
          return def.submit(p.arg as Parameters<typeof def.submit>[0], ctx)
        case 'poll':
          return def.poll!(p.arg as string, ctx)
        case 'cancel':
          return def.cancel!(p.arg as string, ctx)
        case 'test':
          return def.test!(ctx)
        case 'lookup':
          return def.lookup!(p.arg as string, ctx)
      }
    }
    throw new Error(`不认识的请求 ${method}`)
  }

  process.on('message', (raw) => {
    const m = raw as RpcMessage
    if (m.t === 'res') {
      const w = waiting.get(m.id)
      if (!w) return
      waiting.delete(m.id)
      if (m.ok) w.ok(m.value)
      else w.fail(fromRpcError(m.error))
    } else if (m.t === 'abort') {
      running.get(m.id)?.abort(Object.assign(new Error('已取消'), { name: 'AbortError' }))
    } else if (m.t === 'req') {
      const ctrl = new AbortController()
      running.set(m.id, ctrl)
      handle(m.id, m.method, m.params, ctrl.signal)
        .then(
          (value) => post({ t: 'res', id: m.id, ok: true, value: value ?? null }),
          (err) => post({ t: 'res', id: m.id, ok: false, error: toRpcError(err) }),
        )
        .finally(() => running.delete(m.id))
    }
  })
  // 宿主断开 IPC 就退出，不留孤儿进程
  process.on('disconnect', () => process.exit(0))
}

const schema = (s: z.ZodType) =>
  z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>

/** 声明摊平成纯数据：zod 换成 JSON Schema，函数换成「有没有」 */
export function describe(sp: ServerPluginDefinition): PluginDescriptor {
  const perm = proc().permission
  const out = {
    rpc: RPC_VERSION,
    manifest: sp.plugin.manifest,
    sandbox: {
      permission: !!perm,
      fsWrite: perm ? perm.has('fs.write') : true,
      net: perm ? netAllowed(perm) : true,
    },
    nodes: sp.plugin.nodes.map(({ params, migrate, applyOutputs, ...rest }) => ({
      ...rest,
      paramsSchema: schema(params),
      hasMigrate: !!migrate,
      hasApplyOutputs: !!applyOutputs,
    })),
    executors: sp.executors.map((e) => nodeKey(e.node.type, e.node.version)),
    providers: sp.providers.map((p) => {
      const { settings, models, test, submit: _s, poll, cancel, lookup, ...rest } = p
      return {
        ...rest,
        settingsSchema: schema(settings),
        models: models.map(({ options, ...m }) => ({
          ...m,
          ...(options ? { optionsSchema: schema(options) } : {}),
        })),
        has: { test: !!test, poll: !!poll, cancel: !!cancel, lookup: !!lookup },
      }
    }),
    prompts: sp.plugin.prompts,
    templates: sp.plugin.templates,
    elements: sp.plugin.elements.length,
    capabilities: sp.capabilities.length,
  }
  return out as unknown as PluginDescriptor
}

/**
 * 子进程能不能自己联网。权限模型管网络要到有 --allow-net 的 Node（25 起）；
 * 更早的版本问 net 会说没有权限，实际却完全不限制，所以先看运行时认不认这个开关
 */
function netAllowed(perm: { has(scope: string): boolean }) {
  if (!proc().allowedNodeEnvironmentFlags?.has('--allow-net')) return true
  try {
    return perm.has('net')
  } catch {
    return true
  }
}
