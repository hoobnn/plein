import { PLUGIN_INSTALL_MAX_UPLOAD, PluginInstallToken } from '@plein/protocol'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AuthEnv } from '../auth'
import { PluginInstallError, type PluginInstaller } from './install'

/** 上传插件代码只在本机免登录模式提供；仍要求 owner，并受应用的来源/桌面令牌防护。 */
export function pluginInstallRoutes(service: PluginInstaller | null) {
  const app = new Hono<AuthEnv>()
  app.use('/api/plugins/install/*', async (c, next) => {
    if (c.var.principal.role !== 'owner')
      return c.json({ error: 'forbidden', message: '只有所有者可以安装插件' }, 403)
    await next()
  })
  app.get('/api/plugins/install/status', (c) =>
    c.json({ available: !!service, maxUploadBytes: PLUGIN_INSTALL_MAX_UPLOAD }),
  )
  app.use('/api/plugins/install/*', async (c, next) => {
    if (!service) return c.json({ error: 'disabled', message: '插件包安装只在本机模式可用' }, 403)
    await next()
  })
  app.use(
    '/api/plugins/install/*',
    bodyLimit({
      maxSize: PLUGIN_INSTALL_MAX_UPLOAD,
      onError: (c) => c.json({ error: 'too_large', message: '插件 ZIP 不能超过 20 MiB' }, 413),
    }),
  )
  app.onError((error, c) => {
    if (error instanceof PluginInstallError)
      return c.json(
        { error: error.code, message: error.message },
        error.code === 'invalid' ? 400 : error.code === 'disabled' ? 403 : 409,
      )
    console.error('[plugin-install]', error)
    return c.json(
      { error: 'install_failed', message: '插件安装失败，请重新选择插件包；原有插件保持不变' },
      500,
    )
  })
  app.post('/api/plugins/install/preview', async (c) => {
    if (c.req.header('content-type')?.split(';')[0] !== 'application/zip')
      return c.json({ error: 'invalid', message: '请选择 ZIP 插件包' }, 400)
    return c.json(
      await service!.preview(new Uint8Array(await c.req.arrayBuffer()), c.var.principal.id),
    )
  })
  app.post('/api/plugins/install/confirm', async (c) => {
    const token = PluginInstallToken.safeParse(await c.req.json().catch(() => null))
    if (!token.success) return c.json({ error: 'invalid', message: '预检令牌不合法' }, 400)
    return c.json(await service!.install(token.data.token, c.var.principal.id), 201)
  })
  app.delete('/api/plugins/install/:token', async (c) => {
    const token = PluginInstallToken.safeParse({ token: c.req.param('token') })
    if (!token.success) return c.json({ error: 'invalid', message: '预检令牌不合法' }, 400)
    await service!.cancel(token.data.token, c.var.principal.id)
    return c.body(null, 204)
  })
  return app
}
