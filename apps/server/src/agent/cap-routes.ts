import { CapabilityError } from '@plein/capabilities'
import {
  CapabilityCall,
  type CapabilityCallResult,
  type PluginCapabilityInfo,
} from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { newId } from '../ids'
import type { AssetStore } from '../assets/store'
import type { LibraryStore } from '../library/store'
import type { McpClients } from '../mcp/clients'
import type { PluginHost } from '../plugins/host'
import type { NodeRuns } from '../runs/runs'
import { ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { AgentChanges } from './changes'
import { toToolResult } from './mcp'
import { capabilitiesOf, serverContext } from './tools'
import { capabilityToolName } from '@plein/plugin-sdk'

/** 从 ⌘K 调用后多久内还能撤销 */
const UNDO_TTL_MS = 10 * 60_000

interface Deps {
  db: DB
  rooms: Rooms
  runs: NodeRuns
  host: PluginHost
  assets: AssetStore
  library: LibraryStore
  mcp?: McpClients
}

/**
 * 服务端能力的 HTTP 入口（⌘K 调插件能力）：
 * 每次调用单独记一份改动，返回撤销号，一段时间内能整次撤销（和智能体“撤销这一轮”同一套机制）。
 */
export function capabilityRoutes(deps: Deps) {
  const undoable = new Map<
    string,
    { changes: AgentChanges; ownerId: string; timer: NodeJS.Timeout }
  >()
  const forget = (id: string) => {
    const u = undoable.get(id)
    if (!u) return
    clearTimeout(u.timer)
    u.changes.release()
    undoable.delete(id)
  }

  return new Hono<AuthEnv>()
    .get('/api/capabilities', (c) => {
      const list: PluginCapabilityInfo[] = [...deps.host.registry.capabilities.values()].map(
        ({ def, plugin }) => ({
          name: capabilityToolName(def.id),
          title: def.title,
          description: def.description,
          effect: def.effect,
          ...(def.palette ? { palette: def.palette } : {}),
          plugin: deps.host.pluginManifest(plugin).name,
        }),
      )
      return c.json(list)
    })
    .post('/api/canvases/:canvas/capabilities/:name', async (c) => {
      const { canvas, name } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer')
        return c.json({ error: 'forbidden', message: '只读成员不能操作' }, 403)
      if (!ownsCanvas(deps.db, p.id, canvas))
        return c.json({ error: 'not_found', message: '画布不存在' }, 404)
      const body = CapabilityCall.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const registry = capabilitiesOf(deps.host)
      // 只开放插件能力：自带能力在浏览器里直接跑
      if (registry.get(name)?.group !== 'plugin')
        return c.json({ error: 'not_found', message: `没有能力 ${name}` }, 404)

      const id = newId('cap')
      const changes = new AgentChanges(id, canvas, p.id, deps.rooms, deps.runs)
      changes.begin(id)
      const ctx = serverContext({
        canvasId: canvas,
        ownerId: p.id,
        rooms: deps.rooms,
        runs: deps.runs,
        host: deps.host,
        assets: deps.assets,
        library: deps.library,
        mcp: deps.mcp,
        origin: changes.origin,
        selection: body.data.selection,
        onRun: (nodeId, runId) => changes.recordRun(nodeId, runId),
        onGroup: (groupId) => changes.recordGroup(groupId),
      })
      let out: unknown
      try {
        out = await registry.invoke(name, ctx, body.data.input)
      } catch (err) {
        changes.end()
        changes.undoTurn(id)
        changes.release()
        if (err instanceof CapabilityError)
          return c.json({ error: 'failed', message: err.message }, 422)
        throw err
      }
      const changed = changes.end()
      const result = toToolResult(out)
      const text =
        typeof result === 'string'
          ? result
          : result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
      if (!changed) {
        changes.release()
        return c.json({ result: text } satisfies CapabilityCallResult)
      }
      undoable.set(id, {
        changes,
        ownerId: p.id,
        timer: setTimeout(() => forget(id), UNDO_TTL_MS),
      })
      return c.json({ result: text, undo: id } satisfies CapabilityCallResult)
    })
    .post('/api/capability-calls/:id/undo', (c) => {
      const id = c.req.param('id')
      const u = undoable.get(id)
      if (!u || u.ownerId !== c.var.principal.id)
        return c.json({ error: 'not_found', message: '这次操作已经不能撤销了' }, 404)
      const ok = u.changes.undoTurn(id)
      forget(id)
      if (!ok)
        return c.json({ error: 'conflict', message: '之后又有改动，不能单独撤销这一次' }, 409)
      return c.body(null, 204)
    })
}
