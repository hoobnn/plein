import { z } from 'zod'
import { ProviderError, type ProviderErrorCode } from './provider'

/**
 * 第三方插件子进程与宿主之间的消息（Node IPC，advanced 序列化，能直接传 Uint8Array）。
 * 宿主发起 req，子进程回 res；子进程处理请求时要用宿主的服务（联网、密钥、资产、调模型），
 * 反过来发 req 给宿主，带上它正在处理的那个请求 id（ctx）。宿主发 abort 中止一个请求。
 * 子进程不受信任：宿主按 schema 校验它发来的一切。
 */
export const RPC_VERSION = 1

/** 单条消息上限：超过的请求或结果直接拒绝 */
export const RPC_MAX_BYTES = 32 * 1024 * 1024

export type RpcMessage =
  | { t: 'req'; id: number; method: string; params: unknown; ctx?: number }
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: RpcError }
  | { t: 'abort'; id: number }
  | { t: 'note'; method: 'progress' | 'log'; ctx: number; params: unknown }

export interface RpcError {
  name: string
  message: string
  code?: string
  retryable?: boolean
  outcome?: 'unknown'
}

export function toRpcError(err: unknown): RpcError {
  const e = err as Partial<ProviderError> & { name?: string; message?: string }
  return {
    name: e?.name ?? 'Error',
    message: e?.message ?? String(err),
    ...(e instanceof ProviderError
      ? { code: e.code, retryable: e.retryable, ...(e.outcome ? { outcome: e.outcome } : {}) }
      : {}),
  }
}

/** 还原成错误；带 code 的还原成 ProviderError，宿主按它判断能否重试、提交状态是否未知 */
export function fromRpcError(e: RpcError): Error {
  if (e.code)
    return new ProviderError(e.code as ProviderErrorCode, e.message, {
      retryable: e.retryable,
      ...(e.outcome ? { outcome: e.outcome } : {}),
    })
  const err = new Error(e.message)
  err.name = e.name === 'AbortError' ? 'AbortError' : 'PluginError'
  return err
}

/** 联网请求：子进程把 Request 摊平成字节交给宿主，宿主按清单的域名白名单代发 */
export interface RpcFetchRequest {
  url: string
  method: string
  headers: Array<[string, string]>
  body?: Uint8Array
}
export interface RpcFetchResponse {
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: Uint8Array
}

const Json = z.record(z.string(), z.unknown())
const Port = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  multiple: z.boolean().optional(),
  required: z.boolean().optional(),
})

/** 子进程报上来的插件声明：zod schema 换成 JSON Schema，宿主再还原 */
export const PluginDescriptor = z.object({
  rpc: z.literal(RPC_VERSION),
  manifest: z.unknown(),
  /** 子进程里 Node 权限模型的实际状态：宿主如实显示隔离程度 */
  sandbox: z.object({ permission: z.boolean(), fsWrite: z.boolean(), net: z.boolean() }),
  nodes: z.array(
    z
      .object({
        type: z.string(),
        version: z.number().int().min(1),
        title: z.string(),
        category: z.string(),
        inputs: z.array(Port),
        outputs: z.array(Port),
        paramsSchema: Json,
        hasMigrate: z.boolean(),
        hasApplyOutputs: z.boolean(),
      })
      .loose(),
  ),
  executors: z.array(z.string()),
  providers: z.array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        settingsSchema: Json,
        secrets: z.array(z.object({ name: z.string() }).loose()),
        models: z.array(
          z
            .object({
              id: z.string(),
              capabilities: z.array(z.string()),
              optionsSchema: Json.optional(),
            })
            .loose(),
        ),
        has: z.object({
          test: z.boolean(),
          poll: z.boolean(),
          cancel: z.boolean(),
          lookup: z.boolean(),
        }),
      })
      .loose(),
  ),
  prompts: z.array(z.unknown()),
  templates: z.array(z.unknown()),
  elements: z.number().int(),
  capabilities: z.number().int(),
})
export type PluginDescriptor = z.infer<typeof PluginDescriptor>
