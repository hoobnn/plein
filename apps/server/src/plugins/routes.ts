import {
  type Catalog,
  DefaultModelUpdate,
  LocalPluginUpdate,
  type ProviderConfigView,
  ProviderConfigUpdate,
  type ProviderTestResult,
} from '@plein/protocol'
import {
  Capability,
  describeNode,
  describeProvider,
  providerConfigured,
  providerTestScope,
  ProviderError,
  withDefaultModel,
} from '@plein/plugin-sdk'
import { Hono } from 'hono'
import { z } from 'zod'
import { join } from 'node:path'
import type { AuthEnv } from '../auth'
import { validationMessage } from '../http/validation'
import type { JobStore } from '../runs/store'
import { subtitleCredentialUsage } from '../subtitles/journal'
import type { VoiceStore } from '../voices/store'
import { ConfigError } from './config-store'
import type { ExternalPlugins } from './external'
import type { PluginHost } from './host'

const notFound = { error: 'not_found', message: '平台不存在' }
const forbidden = { error: 'forbidden', message: '只有所有者可以修改平台设置' }

export function catalogOf(host: PluginHost): Catalog {
  const { registry, configs } = host
  host.refreshConfiguredProviders()
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
      ...withDefaultModel(
        describeNode(n.def, n.plugin),
        (cap) => host.defaultModel(cap),
        (cap, ref) => host.models(cap).find((m) => m.ref === ref)?.limits,
      ),
      executable: registry.executors.has(key),
    })),
    providers: [...registry.providers].map(([id, p]) => {
      const cfg = configs.get(id)
      const current = cfg.credentials.find((c) => c.id === cfg.activeCredential)
      return {
        ...describeProvider(p.def, p.plugin),
        enabled: cfg.enabled,
        configured: providerConfigured(p.def, cfg.secrets),
        credentialCount: cfg.credentials.length,
        // 摘要只在多组时需要标出当前用哪一组
        ...(cfg.credentials.length >= 2 && current ? { activeCredentialLabel: current.label } : {}),
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
  return catalog
}

/** 插件目录与平台设置接口 */
export function pluginRoutes(
  host: PluginHost,
  deps: { jobs?: JobStore; voices?: VoiceStore; dataDir?: string } = {},
) {
  const { registry, configs } = host

  const view = (id: string): ProviderConfigView => {
    const c = configs.get(id)
    const def = registry.providers.get(id)!.def
    const taskUsage = deps.jobs?.credentialUsage() ?? {}
    const subtitleUsage = deps.dataDir
      ? subtitleCredentialUsage(join(deps.dataDir, 'subtitle-recognition'))
      : {}
    const voiceUsage = deps.voices?.credentialUsage(id) ?? {}
    return {
      enabled: c.enabled,
      settings: c.settings,
      secrets: Object.fromEntries(def.secrets.map((s) => [s.name, Boolean(c.secrets[s.name])])),
      credentials: c.credentials.map((credential) => ({
        id: credential.id,
        label: credential.label,
        secrets: Object.fromEntries(
          def.secrets.map((s) => [s.name, Boolean(credential.secrets[s.name])]),
        ),
        configured: providerConfigured(def, credential.secrets),
        usage: {
          tasks: (taskUsage[id]?.[credential.id] ?? 0) + (subtitleUsage[id]?.[credential.id] ?? 0),
          voices: voiceUsage[credential.id] ?? 0,
        },
      })),
      activeCredential: c.activeCredential ?? null,
    }
  }

  return new Hono<AuthEnv>()
    .get('/api/catalog', (c) => {
      return c.json(catalogOf(host))
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
      if (!body.success)
        return c.json({ error: 'invalid', message: validationMessage(body.error) }, 400)
      const { settings, secrets, credentials } = body.data
      if (settings) {
        const parsed = entry.def.settings.safeParse(settings)
        if (!parsed.success)
          return c.json({ error: 'invalid', message: validationMessage(parsed.error) }, 400)
      }
      const known = new Set(entry.def.secrets.map((s) => s.name))
      const patches = [
        secrets ?? {},
        ...(credentials?.add ?? []).map((item) => item.secrets),
        ...(credentials?.update ?? []).map((item) => item.secrets ?? {}),
      ]
      const unknown = [
        ...new Set(patches.flatMap((patch) => Object.keys(patch).filter((k) => !known.has(k)))),
      ]
      if (unknown.length)
        return c.json({ error: 'invalid', message: `未知的密钥：${unknown.join('、')}` }, 400)
      try {
        configs.apply(id, body.data)
      } catch (err) {
        if (err instanceof ConfigError)
          return c.json({ error: 'invalid', message: err.message }, 400)
        throw err
      }
      host.refreshConfiguredProviders()
      return c.json(view(id))
    })
    .put('/api/model-defaults', async (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbidden, 403)
      const body = DefaultModelUpdate.safeParse(await c.req.json().catch(() => null))
      const cap = Capability.safeParse(body.data?.capability)
      if (!body.success || !cap.success)
        return c.json({ error: 'invalid', message: '能力或模型不正确' }, 400)
      if (!host.models(cap.data).some((m) => !m.deprecated && m.ref === body.data.model))
        return c.json({ error: 'invalid', message: '模型没启用或不支持这种能力' }, 400)
      host.configs.setDefaultModel(cap.data, body.data.model)
      return c.json({ defaultModels: host.defaultModels() })
    })
    .post('/api/providers/:vendor/:name/test', async (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbidden, 403)
      const id = `${c.req.param('vendor')}/${c.req.param('name')}`
      const provider = registry.providers.get(id)
      if (!provider) return c.json(notFound, 404)
      const body = z
        .object({ credential: z.string().min(1).optional() })
        .safeParse((await c.req.json().catch(() => ({}))) ?? {})
      if (!body.success)
        return c.json({ error: 'invalid', message: validationMessage(body.error) }, 400)
      if (body.data.credential && !configs.credential(id, body.data.credential))
        return c.json({ error: 'invalid', message: '密钥组不存在' }, 400)
      const scope = providerTestScope(provider.def)
      try {
        await host.testProvider(
          id,
          c.var.principal.id,
          AbortSignal.timeout(30_000),
          body.data.credential,
        )
        return c.json({
          ok: true,
          scope,
          modelAccess: 'unverified',
          checkedAt: Date.now(),
          message:
            scope === 'configuration'
              ? '配置检查通过；尚未验证远端密钥、模型权限或网络'
              : '连接检查通过；尚未验证具体模型、资源权限或余额',
        } satisfies ProviderTestResult)
      } catch (err) {
        const e =
          err instanceof ProviderError ? err : new ProviderError('unknown', (err as Error).message)
        return c.json({
          ok: false,
          scope,
          modelAccess: 'unverified',
          checkedAt: Date.now(),
          code: e.code,
          message: e.message,
        } satisfies ProviderTestResult)
      }
    })
}

/** 本机第三方插件：列出数据目录 plugins/ 下的插件，启用、停用、重新加载（只有所有者能改） */
export function localPluginRoutes(ext: ExternalPlugins) {
  const forbid = { error: 'forbidden', message: '只有所有者可以管理插件' }
  const missing = { error: 'not_found', message: '插件不存在' }
  const id = (c: { req: { param(k: string): string } }) =>
    `${c.req.param('vendor')}/${c.req.param('name')}`
  return new Hono<AuthEnv>()
    .get('/api/plugins/local', (c) => c.json(ext.list()))
    .post('/api/plugins/local/rescan', (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbid, 403)
      ext.scan()
      return c.json(ext.list())
    })
    .put('/api/plugins/local/:vendor/:name', async (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbid, 403)
      const body = LocalPluginUpdate.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const info = await ext.setEnabled(id(c), body.data.enabled)
      return info ? c.json(info) : c.json(missing, 404)
    })
    .post('/api/plugins/local/:vendor/:name/reload', async (c) => {
      if (c.var.principal.role !== 'owner') return c.json(forbid, 403)
      const info = await ext.reload(id(c))
      return info ? c.json(info) : c.json(missing, 404)
    })
}
