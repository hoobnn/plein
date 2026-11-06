import { capabilityFor, CapabilityError } from '@plein/capabilities'
import {
  API,
  type Catalog,
  type ProviderConfigView,
  type ProviderTestResult,
} from '@plein/protocol'
import { modelRef } from '@plein/plugin-sdk'
import { z } from 'zod'
import { callInternal } from './internal-api'
import { workspaceToolNames } from './project-caps'
import type { ServerContext } from './tools'

/**
 * 平台与模型设置。密钥明文既不能写入也不能读取：配置读取只给「是否已填写」，
 * 写入只开放启用开关，密钥的录入留在设置页。
 */
const cap = capabilityFor<ServerContext>()
const workspace = <T extends { name: string }>(definition: T): T => {
  workspaceToolNames.add(definition.name)
  return definition
}
/** 平台 id 形如 vendor/name；路径里按两段拼接，先限定字符集 */
const providerId = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, '平台 id 形如 vendor/name，先用 list_providers 查询')
  .refine((id) => !id.split('/').some((part) => /^\.+$/.test(part)), '平台 id 形如 vendor/name')
const HINT = '先用 list_providers 查询平台 id'
const providerPath = (id: string, tail: string) => `/api/providers/${id}/${tail}`
const PATH = (tail: string) => new RegExp(`^/api/providers/[^/]+/[^/]+/${tail}$`)
const SECRETISH = /key|token|secret|password|credential/i

/** 设置里理应没有密钥，但第三方平台的 settings 由插件自己定义：疑似密钥的字段一律掩码 */
const maskSettings = (settings: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(settings).map(([k, v]) => [
      k,
      SECRETISH.test(k) && typeof v === 'string' && v ? '••••••••' : v,
    ]),
  )

export const listProviders = workspace(
  cap({
    name: 'list_providers',
    title: '查看平台与模型设置',
    group: 'project',
    where: 'server',
    effect: 'read',
    description:
      '列出模型平台：id、名称、是否启用 enabled、密钥是否已配置 configured、支持的能力、能否拉取远端模型、各能力当前的默认模型 default_models。传 id 查看单个平台的详情：模型列表、设置项（疑似密钥的字段已掩码）、每组密钥是否已填写（只有 true/false，永远不返回密钥明文）。密钥只能在设置页录入。用 set_provider_enabled 启停，用 set_default_model 改默认模型。',
    input: z.object({ id: providerId.optional().describe('只看这个平台的详情') }),
    run: async (ctx, a) => {
      const catalog = await callInternal<Catalog>(ctx, {
        method: 'GET',
        path: API.catalog,
        pathname: /^\/api\/catalog$/,
      })
      const providers = catalog.providers
      const summary = (p: Catalog['providers'][number]) => ({
        id: p.id,
        title: p.title,
        enabled: p.enabled,
        configured: p.configured,
        credential_count: p.credentialCount,
        capabilities: [...new Set(p.models.flatMap((m) => m.capabilities ?? []))],
        model_count: p.models.length,
        test_scope: p.testScope,
        supports_remote_models: Boolean(p.supportsRemoteModels),
      })
      if (!a.id) return { providers: providers.map(summary), default_models: catalog.defaultModels }
      const pid = a.id
      const found = providers.find((p) => p.id === pid)
      if (!found) throw new CapabilityError(`没有平台 ${a.id}。${HINT}`)
      const config = await callInternal<ProviderConfigView>(
        ctx,
        {
          method: 'GET',
          path: providerPath(a.id, 'config'),
          pathname: PATH('config'),
        },
        HINT,
      )
      return {
        ...summary(found),
        description: found.description,
        settings: maskSettings(config.settings),
        secrets_filled: config.secrets,
        credentials: config.credentials.map((c) => ({
          id: c.id,
          label: c.label,
          configured: c.configured,
          secrets_filled: c.secrets,
          active: config.activeCredential === c.id,
        })),
        active_credential: config.activeCredential,
        models: found.models.map((m) => ({
          ref: modelRef(pid, m.id),
          title: m.title,
          capabilities: m.capabilities,
          ...(m.deprecated ? { deprecated: true } : {}),
          ...(m.price ? { price: m.price } : {}),
        })),
        default_models: catalog.defaultModels,
      }
    },
  }),
)

export const setProviderEnabled = workspace(
  cap({
    name: 'set_provider_enabled',
    title: '启用或停用平台',
    group: 'project',
    where: 'server',
    effect: 'edit',
    description:
      '启用或停用一个模型平台。停用后它的模型不再出现在可选目录里，已在画布上选了该模型的节点会无法运行。启用只在密钥已配置（list_providers 的 configured=true）时才有用；本工具不能录入密钥。',
    input: z.object({ id: providerId, enabled: z.boolean() }),
    run: async (ctx, a) => {
      const view = await callInternal<ProviderConfigView>(
        ctx,
        {
          method: 'PUT',
          path: providerPath(a.id, 'config'),
          pathname: PATH('config'),
          body: { enabled: a.enabled },
        },
        HINT,
      )
      return { id: a.id, enabled: view.enabled }
    },
  }),
)

export const testProvider = workspace(
  cap({
    name: 'test_provider',
    title: '检查平台连接',
    group: 'project',
    where: 'server',
    effect: 'read',
    description:
      '用已保存的密钥检查平台配置或连接（会访问平台，不生成内容、不计生成费用）。返回 ok 与 scope：scope=configuration 只检查了配置；scope=connection 检查了连接；两者都不证明具体模型、权限或余额可用（modelAccess 恒为 unverified）。多组密钥时可用 credential 指定密钥组 id（list_providers 带 id 查看）。',
    input: z.object({ id: providerId, credential: z.string().min(1).max(100).optional() }),
    run: (ctx, a) =>
      callInternal<ProviderTestResult>(
        ctx,
        {
          method: 'POST',
          path: providerPath(a.id, 'test'),
          pathname: PATH('test'),
          body: a.credential ? { credential: a.credential } : {},
        },
        HINT,
      ),
  }),
)

export const refreshRemoteModels = workspace(
  cap({
    name: 'refresh_remote_models',
    title: '刷新平台远端模型列表',
    group: 'project',
    where: 'server',
    effect: 'edit',
    description:
      '重新从平台拉取官方模型列表并更新本机缓存（仅支持列表拉取的平台，list_providers 里 supports_remote_models=true）。需要该平台密钥已配置。返回拉取状态；之后用 list_providers 带 id 查看新模型。',
    input: z.object({ id: providerId }),
    run: (ctx, a) =>
      callInternal(
        ctx,
        {
          method: 'POST',
          path: providerPath(a.id, 'remote-models/refresh'),
          pathname: PATH('remote-models/refresh'),
        },
        HINT,
      ),
  }),
)

export const setDefaultModel = workspace(
  cap({
    name: 'set_default_model',
    title: '设置默认模型',
    group: 'project',
    where: 'server',
    effect: 'edit',
    description:
      '设置某种能力的默认模型（新建节点和未指定模型的节点使用）。capability 如 image.generate、video.generate、text.generate；model 是 list_providers 带 id 返回的模型 ref，该模型必须所在平台已启用且支持这种能力。已有节点上显式选的模型不变。',
    input: z.object({
      capability: z.string().min(1).max(100),
      model: z.string().min(1).max(200).describe('模型 ref，形如 vendor/name:model-id'),
    }),
    run: (ctx, a) =>
      callInternal(
        ctx,
        {
          method: 'PUT',
          path: API.modelDefaults,
          pathname: /^\/api\/model-defaults$/,
          body: { capability: a.capability, model: a.model },
        },
        undefined,
      ),
  }),
)

export const providerCapabilities = [
  listProviders,
  setProviderEnabled,
  testProvider,
  refreshRemoteModels,
  setDefaultModel,
]
