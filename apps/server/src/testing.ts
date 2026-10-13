/**
 * 测试共用：临时数据目录、启动服务、轮询等待、画布与节点构造。
 * 只被 *.test.ts 引用；构建入口是 main.ts，不会打进产物。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDoc, createElement, type PleinDoc, type Port } from '@plein/doc'
import { corePlugin } from '@plein/nodes'
import { afterAll, onTestFinished } from 'vite-plus/test'
import { createServer, type Server } from './app'
import { type Config, loadConfig } from './config'
import { type RunningServer, startServer } from './start'

const dirs: string[] = []
const pending = new Set<() => unknown>()

// 文件跑完：先关掉还开着的服务，再删临时目录
afterAll(async () => {
  for (const close of [...pending]) await close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 临时目录，测试文件结束时删除 */
export function tempDir(prefix = 'plein-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** 测试里创建的服务在这个测试结束时关闭，beforeAll 里创建的在文件结束时关闭；close 可提前手动调用 */
function track<T>(close: () => T): () => T {
  let done: { v: T } | null = null
  const once = () => {
    if (!done) {
      pending.delete(once)
      done = { v: close() }
    }
    return done.v
  }
  pending.add(once)
  try {
    onTestFinished(async () => {
      await once()
    })
  } catch {
    // 不在测试里（beforeAll）：交给文件结束时的 afterAll
  }
  return once
}

export interface BootOptions {
  dataDir?: string
  /** 传给 loadConfig 的环境变量 */
  env?: NodeJS.ProcessEnv
  /** 直接覆盖配置 */
  config?: Partial<Config>
  /** 开发用 mock 平台，默认开启 */
  mock?: boolean
}

function testConfig({ dataDir = tempDir(), env = {}, config = {}, mock = true }: BootOptions) {
  return {
    ...loadConfig({
      PLEIN_DATA_DIR: dataDir,
      PLEIN_PORT: '0',
      ...(mock ? { PLEIN_MOCK_PROVIDER: '1' } : {}),
      ...env,
    }),
    webDist: null,
    ...config,
  }
}

/** 只建应用不监听端口：用 request() 直接调 Hono */
export async function bootServer(opts: BootOptions = {}) {
  const config = testConfig(opts)
  const server = await createServer(config)
  const close = track(() => server.close())
  return { server, dataDir: config.dataDir, close }
}

/** 真正监听端口：需要 fetch / WebSocket 时用 */
export async function startTestServer(opts: BootOptions = {}) {
  const config = testConfig(opts)
  const running: RunningServer = await startServer(config)
  const close = track(() => running.close())
  return { ...running, base: running.url, dataDir: config.dataDir, close }
}

/** 直接调 Hono 应用；免认证模式要求 Host 是本机名 */
export function request(server: Server, path: string, init: RequestInit = {}) {
  return server.app.request(path, {
    ...init,
    headers: {
      host: '127.0.0.1:8787',
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

/** 轮询到 fn 返回真值为止，返回那个值 */
export async function until<T>(fn: () => T | undefined | null | false, timeout = 5000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 新建画布，返回 id 和直接操作服务端房间的文档 */
export async function createCanvas(server: Server) {
  const res = await request(server, '/api/canvases', { method: 'POST', body: '{}' })
  const { id } = (await res.json()) as { id: string }
  return { id, doc: createDoc(server.rooms.get(id).doc, { schedule: () => {} }) }
}

/** mock 平台的设置：默认不延迟、不出错 */
export function mockSettings(server: Server, settings: { latencyMs?: number; failWith?: string }) {
  server.plugins.configs.update('plein/mock', {
    settings: { latencyMs: 0, failWith: 'none', ...settings },
  })
}

// ── 节点 ──

type PortSpec = { id: string; label: string; type: Port['type']; multiple?: boolean }
const toPort = ({ id, label, type, multiple }: PortSpec): Port => ({
  id,
  label,
  type,
  ...(multiple ? { multiple: true } : {}),
})

/** 按节点定义生成元素上的端口 */
function portsOf(def: { inputs: readonly PortSpec[]; outputs: readonly PortSpec[] }) {
  return { inputs: def.inputs.map(toPort), outputs: def.outputs.map(toPort) }
}

const DEFS = new Map(corePlugin.nodes.map((d) => [d.type, d as Parameters<typeof portsOf>[0]]))

/** 第 1 版视频节点的端口（首帧输入）：文档里的旧节点仍是这样，运行前迁移 */
export const VIDEO_V1_PORTS = {
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' as const, multiple: true },
    { id: 'firstFrame', label: '首帧', type: 'image' as const },
  ],
  outputs: [{ id: 'video', label: '视频', type: 'video' as const }],
}

export interface NodeOptions {
  params?: Record<string, unknown>
  /** 默认取当前节点定义的端口 */
  ports?: { inputs: Port[]; outputs: Port[] }
  name?: string
  nodeVersion?: number
  x?: number
  y?: number
  w?: number
  h?: number
  parentId?: string
}

/** 往文档里放一个节点；位置默认 (0, 0)，尺寸 200×200 */
export function addNode(doc: PleinDoc, nodeType: string, opts: NodeOptions = {}) {
  const def = DEFS.get(nodeType)
  const { ports = def && portsOf(def), nodeVersion = 1, x = 0, y = 0, w = 200, h = 200 } = opts
  return createElement(doc, {
    kind: 'node',
    nodeType,
    nodeVersion,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.params ? { params: opts.params } : {}),
    ...(ports ? { ports } : {}),
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    x,
    y,
    w,
    h,
  })
}

/** 角色卡：设定、音色等放在 params 里，连入的参考图就是它的输出 */
export function addCharacter(
  doc: PleinDoc,
  name: string,
  params: Record<string, unknown>,
  at: Pick<NodeOptions, 'x' | 'y' | 'w' | 'h'> = {},
) {
  return addNode(doc, 'plein/character', { name, params, ...at })
}
