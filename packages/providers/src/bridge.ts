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

/** 适配器里某个渠道的全部模型，按声明顺序，id 为渠道内模型 ID。 */
export function adapterModels(adapter: PlatformAdapter, channel: string): ModelSpec[] {
  return adapter.models.flatMap((declaration) => {
    const ref: ChannelRef | undefined = declaration.channels.find(
      (item) => item.channel === channel,
    )
    return ref ? [specFromInfo(toModelInfo(declaration, ref))] : []
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
  /** 同步接口的平台没有任务可轮询：设为 false 时不暴露 `poll` / `cancel`。默认跟随适配器。 */
  poll?: boolean
  /**
   * 提交前的宿主校验（设置是否完整、模型身份是否仍有效、能力是否声明）。
   * 抛 `ProviderError` 即拒绝，不会联网。
   */
  beforeSubmit?(request: ProviderRequest, ctx: ProviderContext<z.output<S>>): void | Promise<void>
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

export function adapterToProvider<S extends z.ZodObject>(
  adapter: PlatformAdapter,
  opts: AdapterProviderOptions<S>,
): ProviderDefinition<S> {
  const { id, title, channel, models, adjustModel, poll, beforeSubmit, ...host } = opts
  const channelId = channel ?? adapter.channels[0]
  if (!channelId) throw new Error(`适配器 ${adapter.id} 没有渠道`)
  const specs =
    models ??
    adapterModels(adapter, channelId).map((spec) => (adjustModel ? adjustModel(spec) : spec))
  const withPoll = (poll ?? true) && adapter.poll !== undefined
  return defineProvider<S>({
    docsUrl: adapter.docsUrl,
    ...host,
    id: id ?? adapter.id,
    title: title ?? adapter.title,
    models: specs,
    async submit(request, ctx) {
      await beforeSubmit?.(request, ctx)
      return nodeBuffers(await adapter.submit(request as AdapterRequest, toAdapterContext(ctx)))
    },
    ...(withPoll
      ? {
          poll: async (remoteId: string, ctx: ProviderContext<z.output<S>>) =>
            nodeBuffers(await adapter.poll!(remoteId, toAdapterContext(ctx))),
        }
      : {}),
    ...(withPoll && adapter.cancel
      ? {
          cancel: (remoteId: string, ctx: ProviderContext<z.output<S>>) =>
            adapter.cancel!(remoteId, toAdapterContext(ctx)),
        }
      : {}),
  })
}
