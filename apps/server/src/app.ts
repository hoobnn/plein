import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { setMediaTools } from './assets/media'
import { AssetStore } from './assets/store'
import { type AuthEnv, createAuth } from './auth'
import type { Config } from './config'
import { assetRoutes } from './http/assets'
import { canvasRoutes } from './http/canvases'
import { desktopGuard, originGuard } from './http/guard'
import { builtinPlugins } from './plugins/builtin'
import { ProviderConfigStore } from './plugins/config-store'
import { PluginHost } from './plugins/host'
import { PluginRegistry } from './plugins/registry'
import { pluginRoutes } from './plugins/routes'
import { runRoutes } from './runs/routes'
import { NodeRuns } from './runs/runs'
import { type DB, openDb } from './storage/db'
import { loadSecrets, type Secrets } from './storage/secrets'
import { Rooms, sqliteDocStore } from './sync/rooms'
import { syncRoutes } from './sync/route'

export interface Server {
  app: Hono<AuthEnv>
  db: DB
  rooms: Rooms
  assets: AssetStore
  plugins: PluginHost
  secrets: Secrets
  close(): void
}

export async function createServer(config: Config): Promise<Server> {
  setMediaTools({ ffmpeg: config.ffmpegPath, ffprobe: config.ffprobePath })
  const db = openDb(config.dataDir)
  const secrets = loadSecrets(config.dataDir)
  const rooms = new Rooms(sqliteDocStore(db))
  const assets = new AssetStore(config.dataDir, db, config.maxUpload)
  await assets.init()
  const plugins = new PluginHost(
    new PluginRegistry(),
    new ProviderConfigStore(config.dataDir, new Set(config.mockProvider ? ['plein/mock'] : [])),
    assets,
  )
  plugins.load(builtinPlugins({ mock: config.mockProvider }), true)
  const auth = await createAuth(config.auth, db, secrets, { publicUrl: config.publicUrl })

  const app = new Hono<AuthEnv>()
  app.onError((err, c) => {
    console.error('[http]', err)
    return c.json({ error: 'internal', message: '服务端错误' }, 500)
  })
  if (config.desktopToken) app.use('*', desktopGuard(config.desktopToken))
  app.use(
    '*',
    originGuard({ authRequired: auth.provider.required, allowedHosts: config.allowedHosts }),
  )
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/', auth.routes)
  app.use('/api/*', auth.requireAuth)
  app.use('/sync/*', auth.requireAuth)
  app.route('/', canvasRoutes(db, rooms))
  app.route('/', assetRoutes(assets))
  app.route('/', syncRoutes(db, rooms))
  app.route('/', pluginRoutes(plugins))
  app.route('/', runRoutes(db, new NodeRuns(rooms, plugins)))
  app.all('/api/*', (c) => c.json({ error: 'not_found', message: '接口不存在' }, 404))

  if (config.webDist) {
    const dist = config.webDist
    app.use('*', serveStatic({ root: dist }))
    // 前端路由回退到 index.html
    const index = await readFile(join(dist, 'index.html'), 'utf8')
    app.get('*', (c) => c.html(index))
  }

  return {
    app,
    db,
    rooms,
    assets,
    plugins,
    secrets,
    close() {
      rooms.closeAll()
      db.close()
    },
  }
}
