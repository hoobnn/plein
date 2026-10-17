/**
 * 0.2 发布指标「迁移成功率」的测量（docs/plan/roadmap-0.2.0.md「架构合同与发布指标」）。
 *
 * 在一个源数据目录里用 mock 平台造出固定的一组项目并导出成项目包，再逐个导入全新的数据目录：
 * 校验素材可读且哈希一致、画布能打开、元素 / 结果 / 资产库条目 / 运行记录数量与包一致，
 * 有序列的项目用本机 ffmpeg 合成，最后再导出一次，把两次的清单与画布内容在 id 映射之外逐项比较。
 * 另用一组人为损坏的包记录拒绝结果：是否拒绝、错误码与提示、拒绝后数据目录有没有残留。
 *
 * 不进 `pnpm test`（不是 *.test.ts）。用法：pnpm --filter @plein/server bench:migration
 * 环境变量 PLEIN_KEEP_DATA=1 时保留临时目录便于排查。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { crc32, deflateRawSync } from 'node:zlib'
import { expandedNodes, expandShots, nodeElementOf, type ShotSource } from '@plein/capabilities'
import {
  connect,
  createDoc,
  createElement,
  currentResult,
  type PleinDoc,
  type Port,
  setParam,
} from '@plein/doc'
import { corePlugin, type Shot, STORYBOARD_TYPE } from '@plein/nodes'
import { describeNode, type NodeDefinition } from '@plein/plugin-sdk'
import type {
  Canvas,
  LibraryItem,
  ProjectImportPreview,
  ProjectImportResult,
  ProjectPackageManifest,
} from '@plein/protocol'
import { eq } from 'drizzle-orm'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import * as Y from 'yjs'
import { createServer, type Server } from '../src/app'
import { hasFfmpeg, mediaCaps } from '../src/assets/media'
import { loadConfig } from '../src/config'
import {
  agentSessions,
  assets,
  canvases,
  impactDecisions,
  jobs,
  libraryItems,
  projects,
} from '../src/storage/schema'

const OWNER = 'local'
const ROOT = mkdtempSync(join(tmpdir(), 'plein-bench-migration-'))
let dirSeq = 0
const freshDir = () => {
  const d = join(ROOT, `data-${++dirSeq}`)
  mkdirSync(d)
  return d
}
const servers: Server[] = []

async function boot(dataDir = freshDir()) {
  const config = {
    ...loadConfig({ PLEIN_DATA_DIR: dataDir, PLEIN_MOCK_PROVIDER: '1', PLEIN_PORT: '0' }),
    webDist: null,
  }
  const server = await createServer(config)
  servers.push(server)
  server.plugins.configs.update('plein/mock', { settings: { latencyMs: 0, failWith: 'none' } })
  return { server, dataDir }
}

function request(server: Server, path: string, init: RequestInit = {}) {
  return server.app.request(path, {
    ...init,
    headers: {
      host: '127.0.0.1:8787',
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

async function call<T>(server: Server, path: string, init: RequestInit = {}) {
  const res = await request(server, path, init)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
}

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const openDoc = (server: Server, canvasId: string) =>
  createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })

// ── 画布构造 ─────────────────────────────────────────

const DEFS = new Map(corePlugin.nodes.map((d) => [d.type, d as unknown as NodeDefinition]))

function addNode(
  doc: PleinDoc,
  nodeType: string,
  opts: { params?: Record<string, unknown>; name?: string; x?: number; y?: number } = {},
) {
  const def = DEFS.get(nodeType)
  const toPort = (p: { id: string; label: string; type: Port['type']; multiple?: boolean }) =>
    ({ id: p.id, label: p.label, type: p.type, ...(p.multiple ? { multiple: true } : {}) }) as Port
  return createElement(doc, {
    kind: 'node',
    nodeType,
    nodeVersion: 1,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.params ? { params: opts.params } : {}),
    ...(def
      ? {
          ports: {
            inputs: def.inputs.map((p) => toPort(p as never)),
            outputs: def.outputs.map((p) => toPort(p as never)),
          },
        }
      : {}),
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: 200,
    h: 200,
  })
}

const make = (type: string) => {
  const def = DEFS.get(type)
  return def && nodeElementOf(describeNode(def, 'plein/core'))
}

async function idle(server: Server, canvasId: string, nodeId: string) {
  const end = Date.now() + 30_000
  while (server.runs.isRunning(canvasId, nodeId)) {
    if (Date.now() > end) throw new Error(`节点 ${nodeId} 一直在运行`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function run(server: Server, canvasId: string, nodeId: string) {
  await idle(server, canvasId, nodeId)
  const status = await server.runs.wait(server.runs.start(canvasId, nodeId, OWNER))
  if (status !== 'succeeded') {
    const err = openDoc(server, canvasId).get(nodeId)?.run?.error
    throw new Error(`源项目构造失败：节点 ${nodeId} ${status} ${err ?? ''}`)
  }
}

async function png(color: string) {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
    .png()
    .toBuffer()
}

async function ingestPng(server: Server, color: string, name: string) {
  return server.assets.ingest(OWNER, Readable.from([await png(color)]), {
    mime: 'image/png',
    name,
  })
}

async function newCanvas(server: Server, title: string, projectId?: string) {
  const { body } = await call<Canvas>(server, '/api/canvases', {
    method: 'POST',
    body: JSON.stringify({ title, ...(projectId ? { projectId } : {}) }),
  })
  return { id: body.id, projectId: body.projectId, doc: openDoc(server, body.id) }
}

async function addLibrary(server: Server, body: Record<string, unknown>) {
  const res = await call<LibraryItem>(server, '/api/library', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (res.status !== 201 && res.status !== 200)
    throw new Error(`资产库条目创建失败 ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

interface Fixture {
  key: string
  label: string
  projectId: string
  candidates: 'current' | 'all'
  /** 有序列节点时在目标目录合成 */
  sequence?: { canvasIndex: number; nodeId: string }
  /** 导入前先往目标目录导入的包（模拟目标目录已有同一所有者的同 id 条目） */
  seedWith?: string
  /** 同一个包导入同一个目标目录两次，第二次作为副本 */
  twice?: boolean
  expect?: { missing?: number; reusedLibrary?: number }
  note?: string
}

const shot = (no: number): Shot => ({
  id: `shot_${no}`,
  no,
  duration: 3,
  shotSize: no % 2 ? '中景' : '近景',
  description: `第 ${no} 镜：林夏在天台`,
  characters: ['林夏'],
  emotion: '紧张',
  lighting: '黄昏',
  sfx: '',
  dialogue: [{ character: '林夏', line: `第 ${no} 句台词` }],
  imagePrompt: `第 ${no} 镜画面，天台，黄昏`,
  motionPrompt: '缓慢推近',
})

/** 六镜头短剧：设定卡（参考图、音色）、分镜展开的图 / 视频 / 配音、配乐、带字幕的序列、多候选 */
async function sixShotDrama(server: Server, ffmpeg: boolean, subtitles: boolean) {
  const { id: canvasId, projectId, doc } = await newCanvas(server, '天台对峙')
  const face = await ingestPng(server, '#c33', '林夏-正面.png')
  const side = await ingestPng(server, '#933', '林夏-侧面.png')
  const roof = await ingestPng(server, '#369', '天台.png')
  const hero = await addLibrary(server, {
    kind: 'character',
    name: '林夏',
    projectId,
    description: '二十五岁，短发，白衬衫',
    voice: { provider: 'plein/mock', voiceId: 'mock-female' },
    images: [
      { slot: 'main', assetId: face.id },
      { slot: 'side', assetId: side.id },
    ],
  })
  const place = await addLibrary(server, {
    kind: 'scene',
    name: '天台',
    projectId,
    images: [{ slot: 'main', assetId: roof.id }],
  })
  const card = addNode(doc, 'plein/character', {
    name: '林夏',
    params: {
      libraryId: hero.id,
      description: '二十五岁，短发，白衬衫',
      voice: { provider: 'plein/mock', voiceId: 'mock-female' },
    },
  })
  const portrait = createElement(doc, {
    kind: 'image',
    assetId: face.id,
    x: 0,
    y: -300,
    w: 64,
    h: 64,
  })
  connect(doc, [portrait, 'image'], [card, 'references'])
  addNode(doc, 'plein/scene', { name: '天台', params: { libraryId: place.id }, x: 300 })
  const board = addNode(doc, STORYBOARD_TYPE, {
    name: '分镜',
    params: { shots: [1, 2, 3, 4, 5, 6].map(shot) },
    x: -800,
  })
  const ids = [1, 2, 3, 4, 5, 6].map((n) => `shot_${n}`)
  expandShots(doc, board, ids, make)
  const byShot = (n: number, role: ShotSource['role']) =>
    expandedNodes(doc, board)
      .get(`shot_${n}`)!
      .find((el) => (el.params?.source as ShotSource | undefined)?.role === role)!.id
  for (const role of ['image', 'video', 'speech'] as const)
    for (const n of [1, 2, 3, 4, 5, 6]) await run(server, canvasId, byShot(n, role))
  // 多候选：第 1、3 镜的图各再出两次
  for (const n of [1, 3])
    for (const extra of ['，逆光', '，手持晃动']) {
      const id = byShot(n, 'image')
      setParam(doc, id, 'prompt', `${String(doc.get(id)!.params!.prompt)}${extra}`)
      await run(server, canvasId, id)
    }
  const music = addNode(doc, 'plein/music', {
    name: '配乐',
    params: { prompt: '紧张的弦乐' },
    y: 1200,
  })
  await run(server, canvasId, music)
  const videos = [1, 2, 3, 4, 5, 6].map((n) => byShot(n, 'video'))
  const seq = addNode(doc, 'plein/sequence', {
    name: '成片',
    params: {
      resolution: '720p',
      subtitles: true,
      clips: videos.map((v, i) => ({ source: v, subtitle: `第 ${i + 1} 句台词` })),
    },
    x: 1600,
  })
  for (const v of videos) connect(doc, [v, 'video'], [seq, 'clips'])
  for (const n of [1, 2, 3, 4, 5, 6])
    connect(doc, [byShot(n, 'speech'), 'audio'], [seq, 'dialogue'])
  connect(doc, [music, 'audio'], [seq, 'music'])
  if (ffmpeg) {
    // 本机 ffmpeg 没有 libass 时先不烧字幕合成一次，再把字幕开关打开，包里仍是带字幕的设置
    if (!subtitles) setParam(doc, seq, 'subtitles', false)
    await run(server, canvasId, seq)
    if (!subtitles) setParam(doc, seq, 'subtitles', true)
  }
  return { projectId, seq }
}

/** 引用全局资产库条目（不归属任何项目）的项目 */
async function libraryRef(server: Server, title: string, globalId: string, globalImage: string) {
  const { id: canvasId, projectId, doc } = await newCanvas(server, title)
  const prop = addNode(doc, 'plein/prop', { name: '铁盒', params: { libraryId: globalId } })
  const ref = createElement(doc, {
    kind: 'image',
    assetId: globalImage,
    x: -300,
    y: 0,
    w: 64,
    h: 64,
  })
  connect(doc, [ref, 'image'], [prop, 'references'])
  const gen = addNode(doc, 'plein/image', { params: { prompt: '桌上的铁盒' }, x: 300 })
  connect(doc, [prop, 'images'], [gen, 'references'])
  await run(server, canvasId, gen)
  return projectId
}

/** 多画布：三张画布，第三张复用第一张的素材；有一个运行中的任务导出为历史 */
async function multiCanvas(server: Server) {
  const a = await newCanvas(server, '第一集')
  const b = await newCanvas(server, '第二集', a.projectId)
  const c = await newCanvas(server, '花絮', a.projectId)
  const photo = await ingestPng(server, '#6a3', '外景.png')
  const img = createElement(a.doc, { kind: 'image', assetId: photo.id, x: 0, y: 0, w: 64, h: 64 })
  const gen = addNode(a.doc, 'plein/image', { params: { prompt: '街角' }, x: 300 })
  connect(a.doc, [img, 'image'], [gen, 'references'])
  await run(server, a.id, gen)
  const text = addNode(b.doc, 'plein/text', { params: { text: '雨夜，镜头推近' } })
  const vid = addNode(b.doc, 'plein/video', { params: { prompt: '雨夜' }, x: 300 })
  connect(b.doc, [text, 'text'], [vid, 'prompt'])
  await run(server, b.id, vid)
  const line = addNode(b.doc, 'plein/speech', { params: { text: '你来晚了' }, y: 300 })
  await run(server, b.id, line)
  createElement(c.doc, { kind: 'image', assetId: photo.id, x: 0, y: 0, w: 64, h: 64 })
  // 模拟导出时第二集的配音还在跑
  server.db.update(jobs).set({ status: 'running' }).where(eq(jobs.node_id, line)).run()
  b.doc.ydoc.transact(() => {
    b.doc.mutable(line)!.set('run', { id: 'run_bench_live', status: 'running', progress: 0.4 })
  })
  return a.projectId
}

/** 附属数据：智能体会话（含修改方案条目）、影响分析的保留决定 */
async function withAgentData(server: Server) {
  const { id: canvasId, projectId, doc } = await newCanvas(server, '带对话的项目')
  const gen = addNode(doc, 'plein/image', { params: { prompt: '第三镜，更紧张' } })
  await run(server, canvasId, gen)
  const now = Date.now()
  server.db
    .insert(agentSessions)
    .values({
      id: 'as_bench_session',
      owner_id: OWNER,
      canvas_id: canvasId,
      agent: 'builtin',
      cli_session: null,
      title: '让第三镜头更紧张',
      items: JSON.stringify([
        { id: 'i1', type: 'user', text: 'AGENT-TRANSCRIPT-MARKER 让第三镜头更紧张', at: now },
        {
          id: 'i2',
          type: 'edit_plan',
          plan: { id: 'plan_bench', summary: '第三镜加手持晃动', targets: [], steps: [] },
          status: 'approved',
          scope: 'text',
          at: now,
        },
      ]),
      created_at: now,
      updated_at: now,
    })
    .run()
  const result = currentResult(doc.get(gen)!)!
  server.db
    .insert(impactDecisions)
    .values({
      id: 'imp_bench',
      owner_id: OWNER,
      canvas_id: canvasId,
      node_id: gen,
      result_id: result.id,
      input_hash: 'h',
      causes: '[]',
      note: '先保留',
      created_at: now,
    })
    .run()
  return projectId
}

/** 导出时就缺素材和资产库条目的项目 */
async function withMissing(server: Server) {
  const { projectId, doc } = await newCanvas(server, '缺素材的项目')
  createElement(doc, { kind: 'image', assetId: 'f'.repeat(64), x: 0, y: 0, w: 10, h: 10 })
  addNode(doc, 'plein/prop', { name: '已删除的道具', params: { libraryId: 'lib_gone' }, x: 300 })
  return projectId
}

// ── 包内容的规范化与比较 ─────────────────────────────

interface Pkg {
  data: Buffer
  files: Record<string, Uint8Array>
  manifest: ProjectPackageManifest
}

function readPkg(data: Buffer): Pkg {
  const files = unzipSync(data)
  return { data, files, manifest: JSON.parse(strFromU8(files['manifest.json']!)) }
}

async function exportPkg(server: Server, projectId: string, candidates: 'current' | 'all') {
  const res = await request(
    server,
    `/api/projects/${projectId}/package${candidates === 'all' ? '?history=1' : ''}`,
  )
  if (res.status !== 200) throw new Error(`导出失败 ${res.status} ${await res.text()}`)
  return readPkg(Buffer.from(await res.arrayBuffer()))
}

/** 画布文档的内容（meta、元素、连线），与编码无关 */
function docJson(data: Uint8Array) {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, data)
  const out = {
    meta: ydoc.getMap('meta').toJSON(),
    elements: ydoc.getMap('elements').toJSON() as Record<string, Record<string, unknown>>,
    edges: ydoc.getMap('edges').toJSON(),
  }
  ydoc.destroy()
  return out
}

function deepReplace(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v
  if (Array.isArray(v)) return v.map((x) => deepReplace(x, map))
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepReplace(x, map)]))
  return v
}

/** 两个 JSON 值不同的路径（最多 n 条） */
function diff(a: unknown, b: unknown, path = '', out: string[] = [], n = 6): string[] {
  if (out.length >= n) return out
  if (a === b) return out
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys)
      diff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
        out,
        n,
      )
    return out
  }
  out.push(
    `${path || '根'}: ${JSON.stringify(a)?.slice(0, 60)} ≠ ${JSON.stringify(b)?.slice(0, 60)}`,
  )
  return out
}

/** 包的可比内容：清单去掉打包时间、画布文件换成文档内容、加上运行记录 */
function canonical(p: Pkg) {
  const m = p.manifest
  const history = m.history ? (JSON.parse(strFromU8(p.files[m.history.path]!)) as unknown) : null
  return {
    manifest: {
      ...m,
      createdAt: 0,
      // 运行记录换了 id 时文件长度和哈希跟着变，内容在 history 里逐项比较
      history: m.history ? { path: m.history.path } : null,
      canvases: m.canvases.map(({ file, ...c }) => ({ ...c, doc: docJson(p.files[file.path]!) })),
    },
    history,
  }
}

/**
 * 第二次导出相对第一次的 id 映射：项目、画布（按创建顺序）、资产库条目（按类型 + 名称）、
 * 运行记录（按创建时间与节点）。返回「新 id → 旧 id」
 */
function idMapping(a: Pkg, b: Pkg) {
  const map = new Map<string, string>()
  const add = (from: string | undefined, to: string | undefined) => {
    if (from && to && from !== to) map.set(from, to)
  }
  add(b.manifest.project.id, a.manifest.project.id)
  b.manifest.canvases.forEach((c, i) => add(c.id, a.manifest.canvases[i]?.id))
  const libKey = (l: ProjectPackageManifest['library'][number], own: string) =>
    `${l.kind}\n${l.name}\n${l.projectId === own ? 'own' : 'shared'}`
  const libA = new Map(a.manifest.library.map((l) => [libKey(l, a.manifest.project.id), l.id]))
  for (const l of b.manifest.library) add(l.id, libA.get(libKey(l, b.manifest.project.id)))
  const jobsOf = (p: Pkg) =>
    p.manifest.history
      ? (JSON.parse(strFromU8(p.files[p.manifest.history.path]!)) as Array<{
          id: string
          nodeId: string
          createdAt: number
        }>)
      : []
  const jobKey = (j: { nodeId: string; createdAt: number }) => `${j.createdAt}\n${j.nodeId}`
  const ja = new Map<string, string[]>()
  for (const j of jobsOf(a)) ja.set(jobKey(j), [...(ja.get(jobKey(j)) ?? []), j.id])
  for (const j of jobsOf(b)) add(j.id, ja.get(jobKey(j))?.shift())
  return map
}

// ── 导入与校验 ───────────────────────────────────────

type Upload = ProjectImportPreview & { error?: string; message?: string }

async function upload(server: Server, data: Uint8Array) {
  return call<Upload>(server, '/api/project-imports', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: data,
  })
}

async function importPkg(server: Server, data: Uint8Array) {
  const preview = await upload(server, data)
  if (preview.status !== 201)
    throw new Error(`预检失败 ${preview.status} ${preview.body.error}：${preview.body.message}`)
  const done = await call<ProjectImportResult>(
    server,
    `/api/project-imports/${preview.body.token}`,
    { method: 'POST' },
  )
  if (done.status !== 201) throw new Error(`确认导入失败 ${done.status}`)
  return { preview: preview.body, result: done.body }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(p)
    }
  }
  await walk(dir)
  return out
}

const countRows = (server: Server) => ({
  projects: server.db.select().from(projects).all().length,
  canvases: server.db.select().from(canvases).all().length,
  library: server.db.select().from(libraryItems).all().length,
  jobs: server.db.select().from(jobs).all().length,
  assets: server.db.select().from(assets).all().length,
})

interface Counts {
  canvases: number
  elements: number
  results: number
  assets: number
  library: number
  jobs: number
}

function pkgCounts(p: Pkg): Counts {
  let elements = 0
  let results = 0
  for (const c of p.manifest.canvases) {
    const els = Object.values(docJson(p.files[c.file.path]!).elements)
    elements += els.length
    for (const el of els) results += Array.isArray(el.results) ? el.results.length : 0
  }
  const history = p.manifest.history
    ? (JSON.parse(strFromU8(p.files[p.manifest.history.path]!)) as unknown[]).length
    : 0
  return {
    canvases: p.manifest.canvases.length,
    elements,
    results,
    assets: p.manifest.assets.length,
    library: p.manifest.library.length,
    jobs: history,
  }
}

const ASSET_ID = /^[0-9a-f]{64}$/
const fmt = (c: Counts) =>
  `${c.canvases}/${c.elements}/${c.results}/${c.assets}/${c.library}/${c.jobs}`

interface NormalRow {
  label: string
  ok: boolean
  counts: string
  assets: string
  canvas: string
  compose: string
  reexport: string
  notes: string[]
}

async function verifyImport(
  fx: Fixture,
  pkg: Pkg,
  server: Server,
  dataDir: string,
  composeMode: 'subtitles' | 'plain' | 'skip',
  asCopy: boolean,
): Promise<NormalRow> {
  const notes: string[] = []
  const fail = (msg: string) => notes.push(`✗ ${msg}`)
  const libBefore = server.db.select().from(libraryItems).all().length
  const { preview, result } = await importPkg(server, pkg.data)
  if (preview.copy !== asCopy) fail(`预检 copy=${preview.copy}，应为 ${asCopy}`)
  if (fx.expect?.missing !== undefined && preview.missing.length !== fx.expect.missing)
    fail(`预检缺失 ${preview.missing.length}，应为 ${fx.expect.missing}`)
  if (fx.expect?.reusedLibrary !== undefined && preview.reusedLibrary !== fx.expect.reusedLibrary)
    fail(`复用资产库条目 ${preview.reusedLibrary}，应为 ${fx.expect.reusedLibrary}`)
  if (preview.missing.length) notes.push(`预检列出缺失 ${preview.missing.length} 项`)
  if (preview.reusedLibrary) notes.push(`复用已有资产库条目 ${preview.reusedLibrary} 个`)
  if (asCopy) {
    const r = preview.remapped
    notes.push(`作为副本导入，重映射 画布 ${r.canvases} / 条目 ${r.library} / 任务 ${r.jobs}`)
  }

  // 暂存区已清理
  const staging = (await readdir(join(dataDir, 'tmp')).catch(() => [])).filter((n) =>
    n.startsWith('import-'),
  )
  if (staging.length) fail(`暂存区残留 ${staging.join(',')}`)

  // 画布能打开，数量一致
  const canvasRows = server.db
    .select()
    .from(canvases)
    .where(eq(canvases.project_id, result.projectId))
    .all()
  const want = pkgCounts(pkg)
  const got: Counts = {
    canvases: canvasRows.length,
    elements: 0,
    results: 0,
    assets: 0,
    library: 0,
    jobs: 0,
  }
  let canvasOk = true
  const referenced = new Set<string>()
  for (const row of canvasRows) {
    const res = await request(server, `/api/canvases/${row.id}`)
    if (res.status !== 200) {
      canvasOk = false
      fail(`画布 ${row.title} 打不开 ${res.status}`)
      continue
    }
    const doc = openDoc(server, row.id)
    if (doc.readOnly) {
      canvasOk = false
      fail(`画布 ${row.title} 只读`)
    }
    for (const el of doc.elements()) {
      got.elements++
      got.results += el.results?.length ?? 0
      if (el.assetId) referenced.add(el.assetId)
      for (const r of el.results ?? []) if ('assetId' in r.value) referenced.add(r.value.assetId)
      if (el.run?.status === 'running' || el.run?.status === 'queued') {
        canvasOk = false
        fail(`节点 ${el.id} 迁入后仍是 ${el.run.status}`)
      }
    }
    got.jobs += server.runs.list(row.id, 10_000).jobs.length
    const active = server.runs
      .list(row.id, 10_000)
      .jobs.filter((j) => j.status === 'queued' || j.status === 'running')
    if (active.length) fail(`${active.length} 个任务迁入后仍在排队 / 运行`)
  }
  const { body: lib } = await call<LibraryItem[]>(server, '/api/library')
  const libIds = new Set(lib.map((l) => l.id))
  for (const l of lib) {
    const inPkg =
      l.projectId === result.projectId ||
      pkg.manifest.library.some((x) => x.id === l.id && x.projectId !== pkg.manifest.project.id)
    if (inPkg) {
      got.library++
      for (const img of l.images ?? []) referenced.add(img.assetId)
    }
  }
  const expectedLibAdded = pkg.manifest.library.length - preview.reusedLibrary
  const libAfter = server.db.select().from(libraryItems).all().length
  if (libAfter - libBefore !== expectedLibAdded)
    fail(`资产库新增 ${libAfter - libBefore} 条，应为 ${expectedLibAdded}`)
  for (const l of pkg.manifest.library)
    if (l.projectId !== pkg.manifest.project.id && !libIds.has(l.id))
      fail(`共享条目 ${l.name} 不在资产库里`)

  // 素材：清单里的每个都可读且哈希一致；文档与资产库引用的都在（导出时就缺的除外）
  let assetOk = true
  for (const a of pkg.manifest.assets) {
    const res = await request(server, `/api/assets/${a.id}`)
    const body = Buffer.from(await res.arrayBuffer())
    if (res.status !== 200 || sha(body) !== a.id) {
      assetOk = false
      fail(`素材 ${a.name} 读取 ${res.status} 或哈希不符`)
    } else got.assets++
  }
  const missingIds = new Set(pkg.manifest.missing.map((m) => m.id))
  for (const id of referenced) {
    if (!ASSET_ID.test(id) || missingIds.has(id)) continue
    if (!server.assets.get(OWNER, id)) {
      assetOk = false
      fail(`引用的素材 ${id.slice(0, 8)} 不在本机`)
    }
  }
  const countOk = fmt(got) === fmt(want)
  if (!countOk) fail(`数量 ${fmt(got)} ≠ 包 ${fmt(want)}`)

  // 再导出，与第一次导出比较
  const again = await exportPkg(server, result.projectId, fx.candidates)
  const map = idMapping(pkg, again)
  const left = canonical(pkg)
  const right = deepReplace(canonical(again), map) as ReturnType<typeof canonical>
  if (asCopy && right.manifest.project.title.endsWith('（副本）')) {
    right.manifest.project.title = right.manifest.project.title.slice(0, -'（副本）'.length)
    notes.push('标题加「（副本）」')
  }
  const d = diff(left, right)
  const reexportOk = d.length === 0
  if (!reexportOk) fail(`再导出差异：${d.join('；')}`)
  const reexport = reexportOk ? `一致（映射 ${map.size} 个 id）` : '不一致'

  // 序列合成
  let compose = '—'
  if (fx.sequence) {
    if (composeMode === 'skip') compose = '跳过（无 ffmpeg）'
    else {
      const row = canvasRows.toSorted((a, b) => a.created_at - b.created_at)[
        fx.sequence.canvasIndex
      ]!
      const doc = openDoc(server, row.id)
      setParam(doc, fx.sequence.nodeId, 'subtitles', composeMode === 'subtitles')
      await idle(server, row.id, fx.sequence.nodeId)
      const status = await server.runs.wait(server.runs.start(row.id, fx.sequence.nodeId, OWNER))
      const node = doc.get(fx.sequence.nodeId)!
      const out = node.results?.length
        ? server.assets.get(OWNER, (currentResult(node)!.value as { assetId: string }).assetId)
        : null
      if (status === 'succeeded' && out?.kind === 'video' && (out.duration ?? 0) > 0)
        compose = `通过 ${out.width}×${out.height} ${out.duration!.toFixed(1)}s${composeMode === 'plain' ? '（未烧字幕：本机 ffmpeg 无 libass）' : '（含字幕）'}`
      else {
        compose = '失败'
        fail(`序列合成 ${status} ${node.run?.error ?? ''}`)
      }
    }
  }

  return {
    label: fx.label + (asCopy ? '（同目录再导入为副本）' : ''),
    ok: notes.every((n) => !n.startsWith('✗')),
    counts: `${fmt(got)}${countOk ? '' : ` ≠ ${fmt(want)}`}`,
    assets: assetOk ? `${got.assets} 个可读，哈希一致` : '有问题',
    canvas: canvasOk ? `${canvasRows.length} 张可打开` : '有问题',
    compose,
    reexport,
    notes,
  }
}

// ── 损坏包 ───────────────────────────────────────────

interface Entry {
  name: string
  data: Uint8Array
  deflate?: boolean
  /** 写进目录的未压缩大小（默认真实大小） */
  declaredSize?: number
}

/** 手写 zip：允许重名、任意条目名，fflate 的 zipSync 做不到 */
function buildZip(entries: Entry[]) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const body = e.deflate ? deflateRawSync(e.data) : Buffer.from(e.data)
    const crc = crc32(e.data)
    const size = e.declaredSize ?? e.data.byteLength
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.byteLength, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.byteLength, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(e.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.byteLength, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.byteLength + body.byteLength
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const entriesOf = (files: Record<string, Uint8Array>, manifest?: unknown): Entry[] =>
  Object.entries(files).map(([name, data]) => ({
    name,
    data:
      name === 'manifest.json' && manifest !== undefined ? strToU8(JSON.stringify(manifest)) : data,
    deflate: name === 'manifest.json' || name.endsWith('.yjs') || name.endsWith('.json'),
  }))

interface CorruptCase {
  label: string
  build: (p: Pkg) => Buffer
  /** 期望的错误码 */
  code: string
  /** 提示里应说清的原因 */
  says: RegExp
}

function corruptCases(): CorruptCase[] {
  const firstAsset = (p: Pkg) => p.manifest.assets[0]!
  const withManifest = (p: Pkg, m: unknown) => buildZip(entriesOf(p.files, m))
  return [
    {
      label: '不是 zip（随机字节）',
      build: () => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)),
      code: 'not_a_package',
      says: /\.plein/,
    },
    {
      label: '截断的 zip（只剩前 60%）',
      build: (p) => p.data.subarray(0, Math.floor(p.data.byteLength * 0.6)),
      code: 'corrupt',
      says: /不完整|损坏/,
    },
    {
      label: '截断的 zip（末尾少 1 字节）',
      build: (p) => p.data.subarray(0, p.data.byteLength - 1),
      code: 'corrupt',
      says: /不完整|损坏/,
    },
    {
      label: '截断的 zip（目录完整、数据段被截掉）',
      build: (p) => {
        // 保留中央目录与结尾记录，前面数据段只留一半：条目越界
        const buf = Buffer.from(p.data)
        const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
        const cdOffset = buf.readUInt32LE(eocd + 16)
        const cut = Math.floor(cdOffset / 2)
        const tail = Buffer.from(buf.subarray(cdOffset))
        const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
        tail.writeUInt32LE(cut, end + 16)
        return Buffer.concat([buf.subarray(0, cut), tail])
      },
      code: 'corrupt',
      says: /损坏|不完整/,
    },
    {
      label: '没有 manifest.json',
      build: (p) => buildZip(entriesOf(p.files).filter((e) => e.name !== 'manifest.json')),
      code: 'not_a_package',
      says: /manifest/,
    },
    {
      label: '素材条目哈希不符（改 1 字节）',
      build: (p) => {
        const path = firstAsset(p).file.path
        const data = new Uint8Array(p.files[path]!)
        data[data.length - 1]! ^= 0xff
        return buildZip(entriesOf({ ...p.files, [path]: data }))
      },
      code: 'hash_mismatch',
      says: /校验值/,
    },
    {
      label: '画布文档哈希不符',
      build: (p) => {
        const path = p.manifest.canvases[0]!.file.path
        const data = new Uint8Array(p.files[path]!)
        data[5]! ^= 0x01
        return buildZip(entriesOf({ ...p.files, [path]: data }))
      },
      code: 'hash_mismatch',
      says: /校验值/,
    },
    {
      label: '清单引用的素材文件缺失',
      build: (p) => {
        const { [firstAsset(p).file.path]: _, ...rest } = p.files
        return buildZip(entriesOf(rest))
      },
      code: 'missing_file',
      says: /缺少/,
    },
    {
      label: '运行记录文件缺失',
      build: (p) => {
        const { 'history/jobs.json': _, ...rest } = p.files
        return buildZip(entriesOf(rest))
      },
      code: 'missing_file',
      says: /缺少/,
    },
    {
      label: '清单版本不支持（formatVersion 99）',
      build: (p) => withManifest(p, { ...p.manifest, formatVersion: 99 }),
      code: 'unsupported_version',
      says: /升级/,
    },
    {
      label: '清单版本非法（formatVersion 0）',
      build: (p) => withManifest(p, { ...p.manifest, formatVersion: 0 }),
      code: 'corrupt',
      says: /formatVersion/,
    },
    {
      label: '清单版本非法（formatVersion 为字符串）',
      build: (p) => withManifest(p, { ...p.manifest, formatVersion: '1' }),
      code: 'corrupt',
      says: /formatVersion/,
    },
    {
      label: '清单格式名不对',
      build: (p) => withManifest(p, { ...p.manifest, format: 'other' }),
      code: 'not_a_package',
      says: /清单/,
    },
    {
      label: '清单字段非法（素材大小为负）',
      build: (p) => {
        const m = structuredClone(p.manifest)
        m.assets[0]!.size = -1
        return withManifest(p, m)
      },
      code: 'corrupt',
      says: /清单内容不合法/,
    },
    {
      label: '清单字段非法（缺 canvases）',
      build: (p) => {
        const { canvases: _, ...m } = p.manifest
        return withManifest(p, m)
      },
      code: 'corrupt',
      says: /canvases/,
    },
    {
      label: '清单不是 JSON',
      build: (p) =>
        buildZip([
          ...entriesOf(p.files).filter((e) => e.name !== 'manifest.json'),
          { name: 'manifest.json', data: strToU8('{"format": "plein-project", '), deflate: true },
        ]),
      code: 'corrupt',
      says: /manifest\.json/,
    },
    {
      label: '素材 id 与文件哈希不一致',
      build: (p) => {
        const m = structuredClone(p.manifest)
        m.assets[0]!.file.sha256 = 'e'.repeat(64)
        return withManifest(p, m)
      },
      code: 'corrupt',
      says: /对不上/,
    },
    {
      label: '路径穿越条目（../evil.txt）',
      build: (p) => buildZip([...entriesOf(p.files), { name: '../evil.txt', data: strToU8('x') }]),
      code: 'unsafe_path',
      says: /越出/,
    },
    {
      label: '路径穿越条目（assets/../../evil）',
      build: (p) =>
        buildZip([...entriesOf(p.files), { name: 'assets/../../evil', data: strToU8('x') }]),
      code: 'unsafe_path',
      says: /越出/,
    },
    {
      label: '绝对路径条目（/tmp/evil）',
      build: (p) => buildZip([...entriesOf(p.files), { name: '/tmp/evil', data: strToU8('x') }]),
      code: 'unsafe_path',
      says: /越出/,
    },
    {
      label: '反斜杠路径条目（..\\evil）',
      build: (p) => buildZip([...entriesOf(p.files), { name: '..\\evil', data: strToU8('x') }]),
      code: 'unsafe_path',
      says: /越出/,
    },
    {
      label: '清单里的路径穿越（canvases/../../x.yjs）',
      build: (p) => {
        const m = structuredClone(p.manifest)
        m.canvases[0]!.file.path = 'canvases/../../x.yjs'
        return withManifest(p, m)
      },
      code: 'unsafe_path',
      says: /约定位置/,
    },
    {
      label: '重复条目（同一素材出现两次）',
      build: (p) => {
        const path = firstAsset(p).file.path
        return buildZip([...entriesOf(p.files), { name: path, data: p.files[path]! }])
      },
      code: 'corrupt',
      says: /两次/,
    },
    {
      label: '重复条目（manifest.json 两份，第二份篡改）',
      build: (p) =>
        buildZip([
          ...entriesOf(p.files),
          {
            name: 'manifest.json',
            data: strToU8(JSON.stringify({ ...p.manifest, assets: [] })),
          },
        ]),
      code: 'corrupt',
      says: /两次/,
    },
    {
      label: '声明尺寸过大（清单写 5 GB）',
      build: (p) => {
        const m = structuredClone(p.manifest)
        m.assets[0]!.size = 5 * 1024 ** 3
        m.assets[0]!.file.size = 5 * 1024 ** 3
        return withManifest(p, m)
      },
      code: 'hash_mismatch',
      says: /校验值/,
    },
    {
      label: '解压后超过声明尺寸（压缩炸弹，64 MB 全零）',
      build: (p) => {
        const path = firstAsset(p).file.path
        return buildZip([
          ...entriesOf(p.files).filter((e) => e.name !== path),
          { name: path, data: new Uint8Array(64 * 1024 * 1024), deflate: true, declaredSize: 100 },
        ])
      },
      code: 'hash_mismatch',
      says: /校验值/,
    },
    {
      label: 'manifest.json 解压后超过 64 MB 上限',
      build: (p) => {
        const text = JSON.stringify(p.manifest)
        const padded = text.slice(0, -1) + ' '.repeat(65 * 1024 * 1024) + '}'
        return buildZip([
          ...entriesOf(p.files).filter((e) => e.name !== 'manifest.json'),
          { name: 'manifest.json', data: strToU8(padded), deflate: true },
        ])
      },
      code: 'corrupt',
      says: /manifest\.json/,
    },
    {
      label: '画布文档内容损坏（哈希按损坏内容重算）',
      build: (p) => {
        const m = structuredClone(p.manifest)
        const junk = strToU8('this is not a yjs update at all')
        const path = m.canvases[0]!.file.path
        m.canvases[0]!.file.sha256 = sha(junk)
        m.canvases[0]!.file.size = junk.byteLength
        return buildZip(entriesOf({ ...p.files, [path]: junk }, m))
      },
      code: 'corrupt',
      says: /文档已损坏/,
    },
    {
      label: '运行记录内容损坏（哈希按损坏内容重算）',
      build: (p) => {
        const m = structuredClone(p.manifest)
        const junk = strToU8('[{"id": 1}]')
        m.history = { path: 'history/jobs.json', sha256: sha(junk), size: junk.byteLength }
        return buildZip(entriesOf({ ...p.files, 'history/jobs.json': junk }, m))
      },
      code: 'corrupt',
      says: /运行记录/,
    },
    {
      label: '不支持的压缩方式（素材条目 method 12）',
      build: (p) => {
        const path = firstAsset(p).file.path
        const buf = buildZip(entriesOf(p.files))
        // 把这个条目在本地头和中央目录里的压缩方式改成 12（bzip2）
        const name = Buffer.from(path)
        let at = buf.indexOf(name)
        while (at >= 0) {
          const local = buf.readUInt32LE(at - 30) === 0x04034b50
          const central = at >= 46 && buf.readUInt32LE(at - 46) === 0x02014b50
          if (local) buf.writeUInt16LE(12, at - 30 + 8)
          if (central) buf.writeUInt16LE(12, at - 46 + 10)
          at = buf.indexOf(name, at + 1)
        }
        return buf
      },
      code: 'hash_mismatch',
      says: /校验值|压缩/,
    },
  ]
}

interface CorruptRow {
  label: string
  rejected: boolean
  code: string
  expected: string
  clear: boolean
  clean: boolean
  residue: string
  message: string
}

async function checkCorrupt(base: Pkg, c: CorruptCase): Promise<CorruptRow> {
  const { server, dataDir } = await boot()
  const before = countRows(server)
  const filesBefore = (await listFiles(join(dataDir, 'assets'))).length
  const data = c.build(base)
  const res = await upload(server, data)
  const rejected = res.status === 422
  // 万一通过了预检，不确认，直接放弃
  if (res.status === 201)
    await request(server, `/api/project-imports/${res.body.token}`, { method: 'DELETE' })
  const after = countRows(server)
  const filesAfter = (await listFiles(join(dataDir, 'assets'))).length
  const tmp = await readdir(join(dataDir, 'tmp')).catch(() => [])
  const residue: string[] = []
  for (const k of Object.keys(before) as Array<keyof typeof before>)
    if (after[k] !== before[k]) residue.push(`${k} +${after[k] - before[k]}`)
  if (filesAfter !== filesBefore) residue.push(`素材文件 +${filesAfter - filesBefore}`)
  if (tmp.length) residue.push(`tmp/ 残留 ${tmp.join(',')}`)
  const message = res.body?.message ?? `HTTP ${res.status}`
  const code = res.body?.error ?? (res.status === 201 ? '（通过预检）' : `HTTP ${res.status}`)
  return {
    label: c.label,
    rejected,
    code,
    expected: c.code,
    clear: rejected && c.says.test(message),
    clean: residue.length === 0,
    residue: residue.join('；') || '无',
    message,
  }
}

// ── 主流程 ───────────────────────────────────────────

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

async function main() {
  const ffmpeg = await hasFfmpeg()
  const caps = await mediaCaps()
  const composeMode = !ffmpeg ? 'skip' : caps.subtitles ? 'subtitles' : 'plain'
  process.stderr.write(
    `ffmpeg: ${ffmpeg ? '可用' : '不可用'}，烧字幕：${caps.subtitles ? '可用' : '不可用'}\n`,
  )

  // 源目录：造项目
  const { server: src } = await boot()
  process.stderr.write('构造源项目…\n')
  const drama = await sixShotDrama(src, ffmpeg, caps.subtitles)
  const shared = await ingestPng(src, '#888', '铁盒.png')
  const globalItem = await addLibrary(src, {
    kind: 'prop',
    name: '铁盒',
    description: '生锈的铁盒（全局条目）',
    images: [{ slot: 'main', assetId: shared.id }],
  })
  const libSeed = await libraryRef(src, '前传（同样引用铁盒）', globalItem.id, shared.id)
  const libProject = await libraryRef(src, '铁盒之谜', globalItem.id, shared.id)
  const emptyCanvas = (await newCanvas(src, '空画布项目')).projectId
  const noCanvas = await (async () => {
    const c = await newCanvas(src, '没有画布的项目')
    const res = await request(src, `/api/canvases/${c.id}`, { method: 'DELETE' })
    if (res.status !== 204 && res.status !== 200) throw new Error(`删除画布失败 ${res.status}`)
    return c.projectId
  })()
  const multi = await multiCanvas(src)
  const agentProject = await withAgentData(src)
  const missingProject = await withMissing(src)

  const dramaSeq = { canvasIndex: 0, nodeId: drama.seq }
  const fixtures: Fixture[] = [
    {
      key: 'drama',
      label: '六镜头短剧（默认范围：当前采用结果）',
      projectId: drama.projectId,
      candidates: 'current',
      sequence: dramaSeq,
    },
    {
      key: 'drama-all',
      label: '六镜头短剧（含历史候选）',
      projectId: drama.projectId,
      candidates: 'all',
      sequence: dramaSeq,
      twice: true,
    },
    {
      key: 'lib-new',
      label: '引用全局资产库条目（目标目录没有）',
      projectId: libProject,
      candidates: 'current',
      expect: { reusedLibrary: 0 },
    },
    {
      key: 'lib-reuse',
      label: '引用全局资产库条目（目标目录已有同 id 条目）',
      projectId: libProject,
      candidates: 'current',
      seedWith: 'lib-seed',
      expect: { reusedLibrary: 1 },
    },
    { key: 'empty', label: '空项目（一张空画布）', projectId: emptyCanvas, candidates: 'current' },
    { key: 'empty0', label: '空项目（没有画布）', projectId: noCanvas, candidates: 'current' },
    {
      key: 'multi',
      label: '多画布项目（3 张，跨画布共用素材，含导出时运行中的任务）',
      projectId: multi,
      candidates: 'all',
    },
    {
      key: 'agent',
      label: '带智能体对话、修改方案与保留决定的项目',
      projectId: agentProject,
      candidates: 'current',
      note: '会话与保留决定按设计不进包',
    },
    {
      key: 'missing',
      label: '导出时就缺素材 / 条目的项目',
      projectId: missingProject,
      candidates: 'current',
      expect: { missing: 2 },
    },
  ]

  const pkgs = new Map<string, Pkg>()
  for (const fx of fixtures) pkgs.set(fx.key, await exportPkg(src, fx.projectId, fx.candidates))
  pkgs.set('lib-seed', await exportPkg(src, libSeed, 'current'))

  // 附属数据：确认包里没有会话内容
  const agentPkg = pkgs.get('agent')!
  const leaked = Object.values(agentPkg.files).some((f) =>
    Buffer.from(f).toString('utf8').includes('AGENT-TRANSCRIPT-MARKER'),
  )

  const normal: NormalRow[] = []
  for (const fx of fixtures) {
    process.stderr.write(`导入 ${fx.label}…\n`)
    const pkg = pkgs.get(fx.key)!
    const { server, dataDir } = await boot()
    try {
      if (fx.seedWith) await importPkg(server, pkgs.get(fx.seedWith)!.data)
      const row = await verifyImport(fx, pkg, server, dataDir, composeMode, false)
      if (fx.key === 'agent') {
        const sessions = server.db.select().from(agentSessions).all().length
        const decisions = server.db.select().from(impactDecisions).all().length
        row.notes.push(
          `包内${leaked ? '含' : '无'}会话内容；迁入后会话 ${sessions} 条、保留决定 ${decisions} 条（按设计不迁移）`,
        )
        if (leaked) {
          row.ok = false
          row.notes.push('✗ 会话内容进了项目包')
        }
      }
      if (fx.seedWith) row.notes.push('目标目录先导入了引用同一条目的另一个项目')
      normal.push(row)
      if (fx.twice) normal.push(await verifyImport(fx, pkg, server, dataDir, composeMode, true))
    } catch (err) {
      normal.push({
        label: fx.label,
        ok: false,
        counts: '—',
        assets: '—',
        canvas: '—',
        compose: '—',
        reexport: '—',
        notes: [`✗ ${(err as Error).message}`],
      })
    }
  }

  process.stderr.write('损坏包…\n')
  const base = pkgs.get('multi')!
  const corrupt: CorruptRow[] = []
  for (const c of corruptCases()) corrupt.push(await checkCorrupt(base, c))

  // ── 输出 ──
  const lines: string[] = []
  lines.push(`### 正常包（新数据目录导入 → 校验 → 再导出）`, '')
  lines.push(
    '| 包 | 结果 | 画布/元素/结果/素材/条目/任务 | 素材 | 画布 | 序列合成 | 再导出比较 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const r of normal)
    lines.push(
      `| ${esc(r.label)} | ${r.ok ? '✓' : '✗'} | ${r.counts} | ${r.assets} | ${r.canvas} | ${esc(r.compose)} | ${esc(r.reexport)} | ${esc(r.notes.join('；') || '—')} |`,
    )
  lines.push('', '### 损坏包（应拒绝）', '')
  lines.push(
    '| 损坏方式 | 拒绝 | 错误码（期望） | 提示说清原因 | 无残留 | 提示 |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  for (const r of corrupt)
    lines.push(
      `| ${esc(r.label)} | ${r.rejected ? '✓' : '✗'} | ${r.code}${r.code === r.expected ? '' : `（${r.expected}）`} | ${r.clear ? '✓' : '✗'} | ${r.clean ? '✓' : `✗ ${esc(r.residue)}`} | ${esc(r.message)} |`,
    )
  const okNormal = normal.filter((r) => r.ok).length
  const okCorrupt = corrupt.filter((r) => r.rejected && r.clean).length
  const exact = corrupt.filter(
    (r) => r.rejected && r.clean && r.code === r.expected && r.clear,
  ).length
  lines.push(
    '',
    `正常包导入成功率：${okNormal}/${normal.length}`,
    `损坏包正确拒绝率（拒绝且无残留）：${okCorrupt}/${corrupt.length}；其中错误码与提示都对的：${exact}/${corrupt.length}`,
    `ffmpeg：${ffmpeg ? '可用' : '不可用'}；烧字幕（libass）：${caps.subtitles ? '可用' : '不可用'}`,
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return okNormal === normal.length && okCorrupt === corrupt.length
}

let passed = false
try {
  passed = await main()
} finally {
  for (const s of servers) await s.close()
  if (process.env.PLEIN_KEEP_DATA) process.stderr.write(`数据保留在 ${ROOT}\n`)
  else rmSync(ROOT, { recursive: true, force: true })
}
process.exit(passed ? 0 : 1)
