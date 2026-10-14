import {
  type Catalog,
  DefaultModelUpdate,
  type ProviderConfigView,
  ProviderConfigUpdate,
  type ProviderTestResult,
} from '@plein/protocol'
import {
  Capability,
  describeNode,
  describeProvider,
  providerConfigured,
  ProviderError,
  withDefaultModel,
} from '@plein/plugin-sdk'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AuthEnv } from '../auth'
import type { PluginHost } from './host'

const notFound = { error: 'not_found', message: '平台不存在' }
const forbidden = { error: 'forbidden', message: '只有所有者可以修改平台设置' }

/** 插件目录与平台设置接口 */
export function pluginRoutes(host: PluginHost) {
  const { registry, configs } = host

  const view = (id: string): ProviderConfigView => {
    const c = configs.get(id)
    const def = registry.providers.get(id)!.def
    return {
      enabled: c.enabled,
      settings: c.settings,
      secrets: Object.fromEntries(def.secrets.map((s) => [s.name, Boolean(c.secrets[s.name])])),
    }
  }

  return new Hono<AuthEnv>()
    .get('/api/catalog', (c) => {
      const catalog: Catalog = {
        plugins: registry.plugins.map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          version: p.manifest.version,
          description: p.manifest.description,
          builtin: p.builtin,
          status: p.status,
          error: p.error,
          contributes: p.manifest.contributes,
          permissions: p.manifest.permissions,
        })),
        nodes: [...registry.nodes].map(([key, n]) => ({
          ...withDefaultModel(describeNode(n.def, n.plugin), (cap) => host.defaultModel(cap)),
          executable: registry.executors.has(key),
        })),
        providers: [...registry.providers].map(([id, p]) => {
          const cfg = configs.get(id)
          return {
            ...describeProvider(p.def, p.plugin),
            enabled: cfg.enabled,
            configured: providerConfigured(p.def, cfg.secrets),
          }
        }),
        defaultModels: host.defaultModels(),
        templates: [...registry.templates.values()].map((t) => ({ ...t.def, plugin: t.plugin })),
        prompts: [...registry.prompts.values()].map((p) => ({ ...p.def, plugin: p.plugin })),
        elements: [...registry.elements.values()].map((e) => ({
          type: e.def.type,
          title: e.def.title,
          description: e.def.description,
          defaultSize: e.def.defaultSize,
          dataSchema: z.toJSONSchema(e.def.data, { io: 'input', unrepresentable: 'any' }) as Record<
            string,
            unknown
          >,
          plugin: e.plugin,
        })),
      }
      return c.json(catalog)
    })
    .get('/api/providers/:vendor/:name/config', (c) => {
      const id = `${c.req.param('vendor')}/${c.req.param('name')}`
      if (!registry.providers.has(id)) return c.json(notFound, 404)
      return c.json(view(id))
    })
    .put('/api/providers/:vendor/:name/config', async (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbidden, 403)
      const id = `${c.req.param('vendor')}/${c.req.param('name')}`
      const entry = registry.providers.get(id)
      if (!entry) return c.json(notFound, 404)
      const body = ProviderConfigUpdate.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const { settings, secrets } = body.data
      if (settings) {
        const parsed = entry.def.settings.safeParse(settings)
        if (!parsed.success) return c.json({ error: 'invalid', message: parsed.error.message }, 400)
      }
      const known = new Set(entry.def.secrets.map((s) => s.name))
      const unknown = Object.keys(secrets ?? {}).filter((k) => !known.has(k))
      if (unknown.length)
        return c.json({ error: 'invalid', message: `未知的密钥：${unknown.join('、')}` }, 400)
      configs.update(id, body.data)
      return c.json(view(id))
    })
    .put('/api/model-defaults', async (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbidden, 403)
      const body = DefaultModelUpdate.safeParse(await c.req.json().catch(() => null))
      const cap = Capability.safeParse(body.data?.capability)
      if (!body.success || !cap.success)
        return c.json({ error: 'invalid', message: '能力或模型不正确' }, 400)
      if (!host.models(cap.data).some((m) => m.ref === body.data.model))
        return c.json({ error: 'invalid', message: '模型没启用或不支持这种能力' }, 400)
      host.configs.setDefaultModel(cap.data, body.data.model)
      return c.json({ defaultModels: host.defaultModels() })
    })
    .post('/api/providers/:vendor/:name/test', async (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbidden, 403)
      const id = `${c.req.param('vendor')}/${c.req.param('name')}`
      if (!registry.providers.has(id)) return c.json(notFound, 404)
      try {
        await host.testProvider(id, c.var.principal.id, AbortSignal.timeout(30_000))
        return c.json({
          ok: true,
          ...(registry.providers.get(id)!.def.testScope === 'configuration'
            ? { message: '配置检查通过；尚未验证远端密钥、模型权限或网络' }
            : {}),
        } satisfies ProviderTestResult)
      } catch (err) {
        const e =
          err instanceof ProviderError ? err : new ProviderError('unknown', (err as Error).message)
        return c.json({ ok: false, code: e.code, message: e.message } satisfies ProviderTestResult)
      }
    })
}
