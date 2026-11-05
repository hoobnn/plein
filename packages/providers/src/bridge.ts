/**
 * 把 modelbay 的 `PlatformAdapter` 桥接成 plein 的 `ProviderDefinition`。
 *
 * 分工：请求构造、响应解析、错误归类、模型声明都在 modelbay 适配器里；宿主语义
 * （zod 设置表单、密钥表单、连接检查、远端模型列表、限流、音色复刻表单等）留在 plein，
 * 通过 `opts` 提供。`submit / poll / cancel` 把 plein 的 `ProviderContext` 原样交给适配器，
 * 不做任何 settings→secret 的字符串编码：`ctx.settings` 直接透传。
 */
import {
  type AdapterContext,
  type AdapterRequest,
  type ChannelRef,
  type PlatformAdapter,
  toModelInfo,
} from '@modelbay/core'
import {
  type ModelInfo,
  type ModelSpec,
  type ProviderContext,
  type ProviderDefinition,
  type ProviderRequest,
  defineProvider,
} from '@plein/plugin-sdk'
import { z } from 'zod'

/** JSON Schema 里表示结构与校验的关键字；其余（title / description / labels / placeholder 等）算表单元信息。 */
const STRUCTURAL_KEYWORDS = new Set([
  '$ref',
  '$defs',
  '$schema',
  '$id',
  'type',
  'enum',
  'const',
  'items',
  'prefixItems',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'nullable',
  'readOnly',
  'writeOnly',
])

function metaOf(property: unknown): Record<string, unknown> | undefined {
  if (!property || typeof property !== 'object' || Array.isArray(property)) return
  const meta = Object.fromEntries(
    Object.entries(property).filter(([key]) => !STRUCTURAL_KEYWORDS.has(key)),
  )
  return Object.keys(meta).length ? meta : undefined
}

/**
 * 把声明里的 `optionsSchema`（JSON Schema）还原成 plein 的 zod 对象。
 *
 * zod 的 `fromJSONSchema` 不保留属性级元信息，而 plein 的设置页和运行时报错
 * （`modelOptionsProblem` 读 `shape[key].meta()?.title`）都依赖 title / description /
 * labels / placeholder 等，所以这里把每个属性上的元信息显式挂回。
 */
export function optionsFromSchema(schema: Record<string, unknown>): z.ZodObject {
  const base = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(base.shape)) {
    const meta = metaOf(properties[key])
    shape[key] = meta ? (field as z.ZodType).meta(meta) : (field as z.ZodType)
  }
  return base.extend(shape)
}

/** `toModelInfo` 的结果转成 plein 的 `ModelSpec`：JSON Schema 还原成 zod。 */
export function specFromInfo(info: ModelInfo): ModelSpec {
  const { optionsSchema, ...rest } = info
  return optionsSchema ? { ...rest, options: optionsFromSchema(optionsSchema) } : rest
}

/**
 * 适配器里某个渠道的全部模型，按声明顺序，id 为渠道内模型 ID。
 * 派生后没有 plein 能力的声明（向量化、重排、识别等 plein 暂无对应能力的模型）不进目录。
 */
export function adapterModels(adapter: PlatformAdapter, channel: string): ModelSpec[] {
  return adapter.models.flatMap((declaration) => {
    const ref: ChannelRef | undefined = declaration.channels.find(
      (item) => item.channel === channel,
    )
    if (!ref) return []
    const spec = specFromInfo(toModelInfo(declaration, ref))
    return spec.capabilities.length > 0 ? [spec] : []
  })
}

/**
 * 宿主侧的 provider 定义。除下列字段外，`ProviderDefinition` 的其余字段
 * （`listRemoteModels`、`remoteModelsScope`、`remoteModelsSettings`、`limits`、`testScope`、
 * `test`、`lookup`、`idempotent`、`voiceClone`、`voiceDesign`、`credentialAlternatives`）
 * 原样挂到 provider 上。
 */
export interface AdapterProviderOptions<S extends z.ZodObject> extends Omit<
  ProviderDefinition<S>,
  'id' | 'title' | 'models' | 'submit' | 'poll' | 'cancel'
> {
  /** 默认取适配器的 `id` / `title` / `docsUrl`。 */
  id?: string
  title?: string
  /** 取哪个渠道的模型声明；默认适配器的第一个渠道。 */
  channel?: string
  /** 直接给定模型列表（如兼容渠道的动态单模型），不再从声明派生。 */
  models?: ModelSpec[]
  /** 对派生出的模型逐个调整（补 plein 独有的字段）。 */
  adjustModel?(spec: ModelSpec): ModelSpec
  /**
   * 宿主沙箱对未声明的密钥名直接抛错，而适配器会按名探测 MCP / CLI 用的别名与覆盖项。
   * 设为 true 时，适配器（以及 `test` / `listRemoteModels`）看到的 `ctx.secret` 只放行
   * `secrets` 里声明的名字，其余按「未设置」返回 undefined，让适配器走默认值。
   */
  declaredSecretsOnly?: boolean
  /** 同步接口的平台没有任务可轮询：设为 false 时不暴露 `poll` / `cancel`。默认跟随适配器。 */
  poll?: boolean
  /**
   * 提交前的宿主校验（设置是否完整、模型身份是否仍有效、能力是否声明）。
   * 抛 `ProviderError` 即拒绝，不会联网。
   */
  beforeSubmit?(request: ProviderRequest, ctx: ProviderContext<z.output<S>>): void | Promise<void>
  /**
   * 交给适配器之前改写请求（宿主语义：某平台的某类能力忽略 plein 传入的 `extra` 之类）。
   * 在统一剥离 `callback_url` 之后调用，返回的请求才会提交。
   */
  prepareRequest?(request: ProviderRequest): ProviderRequest
}

/** 请求里可能携带平台回调地址的几处位置：`input` 本身及其 `extra` / `options` / `parameters`。 */
const CALLBACK_HOLDERS = ['extra', 'options', 'parameters'] as const

function withoutCallback(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (!('callback_url' in value)) return value
  const { callback_url: _dropped, ...rest } = value as Record<string, unknown>
  return rest
}

/**
 * plein 宿主不需要平台回调（结果一律靠轮询取回），而协作文档里的 extra / options 可能被他人
 * 写入回调地址，把任务结果推到外部。所以桥接对所有平台统一剥离 `callback_url`。
 */
export function stripCallbackUrl(request: ProviderRequest): ProviderRequest {
  const input = request.input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return request
  let next: Record<string, unknown> = withoutCallback(input) as Record<string, unknown>
  for (const key of CALLBACK_HOLDERS) {
    const cleaned = withoutCallback(next[key])
    if (cleaned !== next[key]) next = { ...next, [key]: cleaned }
  }
  return next === input ? request : ({ ...request, input: next } as ProviderRequest)
}

/** plein 的上下文是 modelbay `AdapterContext` 的子集，`settings` / `files` / `stream` 等原样透传。 */
export function toAdapterContext<S>(ctx: ProviderContext<S>): AdapterContext {
  return ctx as unknown as AdapterContext
}

/**
 * modelbay 的文件输出是运行时无关的 `Uint8Array`；plein 服务端一直按 Node `Buffer`
 * 处理产物（落盘、base64），桥接时零拷贝地换成 `Buffer` 视图。
 */
function nodeBuffers<R>(result: R): R {
  const outputs = (result as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return result
  return {
    ...result,
    outputs: outputs.map((output: { type?: string; data?: Uint8Array }) =>
      output.type === 'file' && output.data && !Buffer.isBuffer(output.data)
        ? {
            ...output,
            data: Buffer.from(output.data.buffer, output.data.byteOffset, output.data.byteLength),
          }
        : output,
    ),
  }
}

/** 只放行 `names` 里的密钥，其余返回 undefined（不抛错）。 */
function onlySecrets<C extends { secret(name: string): string | undefined }>(
  ctx: C,
  names: ReadonlySet<string>,
): C {
  return { ...ctx, secret: (name: string) => (names.has(name) ? ctx.secret(name) : undefined) }
}

export function adapterToProvider<S extends z.ZodObject>(
  adapter: PlatformAdapter,
  opts: AdapterProviderOptions<S>,
): ProviderDefinition<S> {
  const {
    id,
    title,
    channel,
    models,
    adjustModel,
    poll,
    beforeSubmit,
    prepareRequest,
    declaredSecretsOnly,
    ...host
  } = opts
  const channelId = channel ?? adapter.channels[0]
  if (!channelId) throw new Error(`适配器 ${adapter.id} 没有渠道`)
  const specs =
    models ??
    adapterModels(adapter, channelId).map((spec) => (adjustModel ? adjustModel(spec) : spec))
  const withPoll = (poll ?? true) && adapter.poll !== undefined
  const declared = new Set(host.secrets.map((secret) => secret.name))
  const scoped = <C extends ProviderContext<z.output<S>>>(ctx: C): C =>
    declaredSecretsOnly ? onlySecrets(ctx, declared) : ctx
  const { test, listRemoteModels } = host
  return defineProvider<S>({
    docsUrl: adapter.docsUrl,
    ...host,
    ...(test ? { test: (ctx: ProviderContext<z.output<S>>) => test(scoped(ctx)) } : {}),
    ...(listRemoteModels
      ? { listRemoteModels: (ctx: ProviderContext<z.output<S>>) => listRemoteModels(scoped(ctx)) }
      : {}),
    id: id ?? adapter.id,
    title: title ?? adapter.title,
    models: specs,
    async submit(request, ctx) {
      await beforeSubmit?.(request, ctx)
      const prepared = prepareRequest
        ? prepareRequest(stripCallbackUrl(request))
        : stripCallbackUrl(request)
      return nodeBuffers(
        await adapter.submit(prepared as AdapterRequest, toAdapterContext(scoped(ctx))),
      )
    },
    ...(withPoll
      ? {
          poll: async (remoteId: string, ctx: ProviderContext<z.output<S>>) =>
            nodeBuffers(await adapter.poll!(remoteId, toAdapterContext(scoped(ctx)))),
        }
      : {}),
    ...(withPoll && adapter.cancel
      ? {
          cancel: (remoteId: string, ctx: ProviderContext<z.output<S>>) =>
            adapter.cancel!(remoteId, toAdapterContext(scoped(ctx))),
        }
      : {}),
  })
}
