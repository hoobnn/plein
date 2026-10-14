import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { agentMcpRoute, agentRoutes } from './agent/routes'
import { capabilityRoutes } from './agent/cap-routes'
import { ExternalMcp } from './mcp/external'
import { mcpRoutes } from './mcp/routes'
import { AgentSessions } from './agent/sessions'
import { setSubtitleFont } from './assets/fonts'
import { setMediaTools } from './assets/media'
import { AssetStore } from './assets/store'
import { type AuthEnv, createAuth } from './auth'
import type { Config } from './config'
import { assetRoutes } from './assets/routes'
import { canvasRoutes } from './canvases/routes'
import { previewer } from './storage/previews'
import { desktopGuard, originGuard } from './http/guard'
import { LibraryStore } from './library/store'
import { libraryRoutes } from './library/routes'
import { mediaRoutes } from './assets/media-routes'
import { projectRoutes } from './projects/routes'
import { packageRoutes } from './projects/package-routes'
import { builtinPlugins } from './plugins/builtin'
import { ProviderConfigStore } from './plugins/config-store'
import { PluginHost } from './plugins/host'
import { PluginRegistry } from './plugins/registry'
import { pluginRoutes } from './plugins/routes'
import { runRoutes } from './runs/routes'
import { EditPlans } from './runs/edit-plan'
import { NodeRuns } from './runs/runs'
import { type DB, openDb } from './storage/db'
import { loadSecrets, type Secrets } from './storage/secrets'
import { Rooms, sqliteDocStore } from './sync/rooms'
import { syncRoutes } from './sync/routes'
import { promptRoutes } from './prompt/routes'
import { templateRoutes } from './templates/routes'

export interface Server {
  app: Hono<AuthEnv>
  db: DB
  rooms: Rooms
  assets: AssetStore
  plugins: PluginHost
  secrets: Secrets
  runs: NodeRuns
  plans: EditPlans
  agents: AgentSessions
  library: LibraryStore
  close(): void
}

export async function createServer(config: Config): Promise<Server> {
  setMediaTools({ ffmpeg: config.ffmpegPath, ffprobe: config.ffprobePath })
  setSubtitleFont(config.subtitleFont)
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
  const runs = new NodeRuns(db, rooms, plugins, { concurrency: config.maxJobs })
  const library = new LibraryStore(db)
  // 修改方案：内置智能体、本机 CLI 和对外 MCP 共用一份
  const plans = new EditPlans(db, runs, plugins)
  const agents = new AgentSessions({
    db,
    library,
    rooms,
    runs,
    host: plugins,
    assets,
    plans,
    dataDir: config.dataDir,
    enabled: config.agent,
  })

  // 对外开放 MCP 和本机智能体一样，只在本机免登录模式开放
  const external = config.mcp
    ? new ExternalMcp(config.dataDir, { db, rooms, runs, host: plugins, assets, library, plans })
    : null

  const app = new Hono<AuthEnv>()
  app.onError((err, c) => {
    console.error('[http]', err)
    return c.json({ error: 'internal', message: '服务端错误' }, 500)
  })
  // 智能体的 MCP 请求来自本机 CLI，没有桌面端窗口的 Cookie，用会话令牌单独鉴权
  if (config.desktopToken) {
    const guard = desktopGuard(config.desktopToken)
    app.use('*', (c, next) => (c.req.path === '/mcp' ? next() : guard(c, next)))
  }
  app.use(
    '*',
    originGuard({ authRequired: auth.provider.required, allowedHosts: config.allowedHosts }),
  )
  app.get('/api/health', (c) => c.json({ ok: true }))
  // 放在登录鉴权之前：CLI 用会话令牌访问
  app.route('/', agentMcpRoute(agents, external))
  app.route('/', auth.routes)
  app.use('/api/*', auth.requireAuth)
  app.use('/sync/*', auth.requireAuth)
  const preview = previewer(db)
  app.route('/', projectRoutes(db, rooms, preview))
  app.route('/', packageRoutes({ db, rooms, assets, host: plugins, dataDir: config.dataDir }))
  app.route('/', canvasRoutes(db, rooms, preview))
  app.route('/', libraryRoutes(db, library))
  app.route('/', templateRoutes(db))
  app.route('/', assetRoutes(assets))
  app.route('/', mediaRoutes(assets))
  app.route('/', syncRoutes(db, rooms))
  app.route('/', pluginRoutes(plugins))
  app.route('/', promptRoutes(plugins))
  app.route('/', runRoutes(db, runs))
  app.route('/', agentRoutes(db, agents))
  app.route('/', capabilityRoutes({ db, rooms, runs, host: plugins, assets, library }))
  app.route('/', mcpRoutes(external))
  app.all('/api/*', (c) => c.json({ error: 'not_found', message: '接口不存在' }, 404))

  if (config.webDist) {
    const dist = config.webDist
    app.use('*', serveStatic({ root: dist }))
    // 前端路由回退到 index.html
    const index = await readFile(join(dist, 'index.html'), 'utf8')
    app.get('*', (c) => c.html(index))
  }

  // 接着跑上次退出时没结束的任务
  runs.recover()

  return {
    app,
    db,
    rooms,
    assets,
    plugins,
    secrets,
    runs,
    plans,
    agents,
    library,
    close() {
      agents.close()
      runs.close()
      rooms.closeAll()
      db.$client.close()
    },
  }
}
