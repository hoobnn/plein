import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { createDoc, currentResult, type NodeResult, type NodeRun } from '@plein/doc'
import { parseModelRef } from '@plein/plugin-sdk'
import {
  type Asset,
  type DependencyStatus,
  type LibraryItem,
  PackageJob,
  type PackageAsset,
  type PackageCandidates,
  type PackageCanvas,
  type PackageCheckpoint,
  type PackageFile,
  type PackageLibraryItem,
  type PackageMissing,
  PROJECT_PACKAGE_FORMAT,
  PROJECT_PACKAGE_VERSION,
  type ProjectImportErrorCode,
  type ProjectImportPreview,
  type ProjectImportResult,
  ProjectPackageManifest,
  type ProjectPackageSummary,
} from '@plein/protocol'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import * as Y from 'yjs'
import { z } from 'zod'
import { safeName } from '../assets/interchange'
import type { AssetStore } from '../assets/store'
import {
  checkpointArchive,
  checkpointAssetIds,
  checkpointRows,
  parseCheckpointArchive,
  type CheckpointArchive,
} from '../checkpoints/archive'
import { documentReferences, readDocument } from '../media-index/references'
import type { MediaIndex } from '../media-index/service'
import type { PluginHost } from '../plugins/host'
import { newCanvasId, newProjectId } from '../storage/canvases'
import type { DB } from '../storage/db'
import { canvases, docUpdates, jobs, libraryItems, projects } from '../storage/schema'
import type { Rooms } from '../sync/rooms'
import { openZipEntry, readZipIndex, safeEntryName, ZipError, type ZipEntry } from './zip'

/**
 * 项目包的导出与导入（格式见 @plein/protocol 的 project-package.ts）。
 *
 * 导出：重放画布文档到一份副本上，按候选范围裁剪结果、把运行中状态改成历史，收集文档引用到的素材、
 * 资产库条目和外部依赖，流式写成 zip。导入分两步：先把包放进暂存区，校验版本、路径、哈希并解析文档，
 * 返回预检结果；确认后素材先进内容存储（按哈希寻址，多出来也不影响什么），数据库记录在一个事务里写入，
 * 失败时不留下半个项目。
 */

export interface PackageDeps {
  db: DB
  rooms: Rooms
  assets: AssetStore
  host: PluginHost
  dataDir: string
  mediaIndex?: MediaIndex
}

/** fflate 写的 zip 不带 zip64，单个包不超过 4 GB */
export const PACKAGE_LIMIT = 0xffff_ffff - 64 * 1024 * 1024
/** 预检后多久不确认就放弃暂存 */
const PENDING_TTL = 30 * 60_000
const MANIFEST = 'manifest.json'
const HISTORY = 'history/jobs.json'
const MANIFEST_LIMIT = 64 * 1024 * 1024
const ASSET_ID = /^[0-9a-f]{64}$/
const RUNNING_NOTE = '导出时仍在运行；迁入后不会自动续查或重新提交'

export class PackageError extends Error {
  constructor(
    readonly code: ProjectImportErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class PackageTooLargeError extends Error {}

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** 把错误信息、运行状态里的本机路径换成省略号：数据目录和用户主目录 */
export function pathScrubber(dataDir: string) {
  const roots = [dataDir, homedir()].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)
  return (text: string) => roots.reduce((t, r) => t.split(r).join('…'), text)
}

/** 深度遍历 JSON 值，对每个字符串调用 fn */
function eachString(v: unknown, fn: (s: string) => void) {
  if (typeof v === 'string') fn(v)
  else if (Array.isArray(v)) for (const x of v) eachString(x, fn)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) eachString(x, fn)
}

/** 深度遍历 JSON 值，收集 { provider, voiceId } 形状的音色绑定 */
function eachVoice(v: unknown, fn: (voice: { provider: string; voiceId: string }) => void) {
  if (Array.isArray(v)) for (const x of v) eachVoice(x, fn)
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.voiceId === 'string' && o.voiceId.trim() && typeof o.provider === 'string')
      fn({ provider: o.provider, voiceId: o.voiceId.trim() })
    for (const x of Object.values(o)) eachVoice(x, fn)
  }
}

/** 深度替换 JSON 值里与映射表完全相同的字符串；没有变化时返回原对象 */
function remapValue(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v
  if (Array.isArray(v)) {
    const next = v.map((x) => remapValue(x, map))
    return next.some((x, i) => x !== v[i]) ? next : v
  }
  if (v && typeof v === 'object' && !(v instanceof Y.AbstractType)) {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      next[k] = remapValue(x, map)
      if (next[k] !== x) changed = true
    }
    return changed ? next : v
  }
  return v
}

/** 运行中 / 排队的状态改成已取消的历史记录，不留下进度和阶段 */
function settledRun(run: NodeRun, note: string): NodeRun {
  if (run.status !== 'queued' && run.status !== 'running') return run
  return { id: run.id, status: 'canceled', error: note, at: Date.now() }
}

// ── 导出 ──────────────────────────────────────────────

interface ExportPlan {
  title: string
  manifest: ProjectPackageManifest
  /** 包内路径 → 内容（文档和运行记录） */
  blobs: Map<string, Uint8Array>
  /** 包内路径 → 本机素材文件 */
  files: Map<string, string>
  jobs: number
  bytes: number
}

function loadState(deps: PackageDeps, canvasId: string): Y.Doc {
  const ydoc = new Y.Doc()
  // 已经打开的房间可能有还没落盘的增量，直接取内存里的文档
  if (deps.rooms.has(canvasId)) {
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(deps.rooms.get(canvasId).doc))
    return ydoc
  }
  const rows = deps.db
    .select({ data: docUpdates.data })
    .from(docUpdates)
    .where(eq(docUpdates.canvas_id, canvasId))
    .orderBy(asc(docUpdates.id))
    .all()
  for (const r of rows) Y.applyUpdate(ydoc, new Uint8Array(r.data))
  return ydoc
}

/** 整理出要打包的全部内容；项目不存在时返回 null */
async function planExport(
  deps: PackageDeps,
  owner: string,
  projectId: string,
  candidates: PackageCandidates,
): Promise<ExportPlan | null> {
  const { db, assets: store, host } = deps
  const project = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.owner_id, owner)))
    .get()
  if (!project) return null
  const scrub = pathScrubber(deps.dataDir)
  const rows = db
    .select()
    .from(canvases)
    .where(and(eq(canvases.project_id, projectId), eq(canvases.owner_id, owner)))
    .orderBy(asc(canvases.created_at))
    .all()

  const blobs = new Map<string, Uint8Array>()
  const files = new Map<string, string>()
  /** 资产 id → 第一次被引用的位置；explicit 表示是素材 / 结果 / 资产库图片这类明确的引用 */
  const assetRefs = new Map<string, { where: string; explicit: boolean }>()
  const libraryRefs = new Map<string, string>()
  const models = new Set<string>()
  const voices = new Map<string, { provider: string; voiceId: string }>()
  const nodes = new Map<string, { type: string; version: number; plugin?: string }>()
  const refAsset = (id: string, where: string, explicit: boolean) => {
    const cur = assetRefs.get(id)
    if (!cur) assetRefs.set(id, { where, explicit })
    else if (explicit && !cur.explicit) assetRefs.set(id, { where, explicit })
  }
  const refVoice = (v: { provider: string; voiceId: string }) =>
    voices.set(`${v.provider}\n${v.voiceId}`, v)

  const packageCanvases: PackageCanvas[] = []
  rows.forEach((row, i) => {
    const ydoc = loadState(deps, row.id)
    const doc = createDoc(ydoc, { schedule: () => {} })
    try {
      ydoc.transact(() => {
        for (const el of doc.elements()) {
          const where = `${row.title} / ${el.name ?? el.nodeType ?? el.kind}`
          const m = doc.mutable(el.id)!
          if (el.assetId) refAsset(el.assetId, where, true)
          if (el.results?.length) {
            const cur = currentResult(el)
            const kept =
              candidates === 'all' || !cur
                ? el.results
                : el.results.filter((r) => r.runId === cur.runId)
            if (kept.length !== el.results.length) m.set('results', kept)
            for (const r of kept) if ('assetId' in r.value) refAsset(r.value.assetId, where, true)
          }
          if (el.run) {
            let run = settledRun(el.run, RUNNING_NOTE)
            const error = run.error && scrub(run.error)
            const message = run.message && scrub(run.message)
            if (error !== run.error || message !== run.message)
              run = { ...run, ...(error ? { error } : {}), ...(message ? { message } : {}) }
            if (run !== el.run) m.set('run', run)
          }
          if (el.params) {
            eachString(el.params, (s) => {
              if (ASSET_ID.test(s)) refAsset(s, where, false)
            })
            eachVoice(el.params, refVoice)
            const { libraryId, model, voice } = el.params as Record<string, unknown>
            if (typeof libraryId === 'string' && libraryId) libraryRefs.set(libraryId, where)
            if (typeof model === 'string' && model.trim()) models.add(model.trim())
            // 0.1.0 之前音色是裸字符串，没有平台
            if (typeof voice === 'string' && voice.trim())
              refVoice({ provider: '', voiceId: voice.trim() })
          }
          if (el.kind === 'node' && el.nodeType) {
            const version = el.nodeVersion ?? 1
            const key = `${el.nodeType}@${version}`
            if (!nodes.has(key))
              nodes.set(key, {
                type: el.nodeType,
                version,
                plugin: host.registry.latestNode(el.nodeType)?.plugin,
              })
          }
        }
      })
      const data = Y.encodeStateAsUpdate(ydoc)
      const path = `canvases/${i + 1}.yjs`
      blobs.set(path, data)
      packageCanvases.push({
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        file: { path, sha256: sha(data), size: data.byteLength },
      })
    } finally {
      doc.destroy()
      ydoc.destroy()
    }
  })

  const packageCheckpoints: PackageCheckpoint[] = []
  for (const [i, checkpoint] of checkpointRows(db, owner, projectId).entries()) {
    // 命名保存的候选不能被当前画布的 current/all 选项删掉。
    readDocument(checkpoint.state, (doc) => {
      for (const ref of documentReferences(doc))
        refAsset(ref.assetId, `检查点 ${checkpoint.name} / ${ref.label}`, ref.explicit)
      for (const el of doc.elements()) {
        if (el.params) {
          eachVoice(el.params, refVoice)
          const { libraryId, model } = el.params
          if (typeof libraryId === 'string' && libraryId)
            libraryRefs.set(libraryId, `检查点 / ${checkpoint.name}`)
          if (typeof model === 'string' && model.trim()) models.add(model.trim())
        }
        if (el.nodeType) {
          const version = el.nodeVersion ?? 1
          nodes.set(`${el.nodeType}@${version}`, {
            type: el.nodeType,
            version,
            plugin: host.registry.latestNode(el.nodeType)?.plugin,
          })
        }
      }
    })
    const archive = checkpointArchive(checkpoint)
    const data = strToU8(scrub(JSON.stringify(archive)))
    const path = `checkpoints/${i + 1}.json`
    blobs.set(path, data)
    packageCheckpoints.push({
      id: checkpoint.id,
      sourceCanvasId: checkpoint.source_canvas_id,
      sourceCanvasTitle: checkpoint.source_canvas_title,
      name: checkpoint.name,
      createdAt: checkpoint.created_at,
      file: { path, sha256: sha(data), size: data.byteLength },
    })
  }

  // 资产库：归属这个项目的条目，加上画布上卡片引用的（可能是不归属任何项目的全局条目）
  const owned = db
    .select()
    .from(libraryItems)
    .where(and(eq(libraryItems.owner_id, owner), eq(libraryItems.project_id, projectId)))
    .all()
  const referenced = libraryRefs.size
    ? db
        .select()
        .from(libraryItems)
        .where(
          and(eq(libraryItems.owner_id, owner), inArray(libraryItems.id, [...libraryRefs.keys()])),
        )
        .all()
    : []
  const libRows = new Map([...owned, ...referenced].map((r) => [r.id, r]))
  const library: PackageLibraryItem[] = []
  for (const r of libRows.values()) {
    const d = JSON.parse(r.data) as Partial<LibraryItem>
    const item: PackageLibraryItem = {
      id: r.id,
      kind: r.kind as PackageLibraryItem['kind'],
      name: r.name,
      projectId: r.project_id,
      description: d.description ?? '',
      tags: d.tags ?? {},
      voice: d.voice ?? null,
      images: d.images ?? [],
      video: d.video ?? null,
      models: d.models ?? [],
      profile: d.profile ?? null,
      favorite: r.favorite === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
    library.push(item)
    const where = `资产库 / ${r.name}`
    eachString({ images: item.images, video: item.video, profile: item.profile }, (s) => {
      if (ASSET_ID.test(s)) refAsset(s, where, true)
    })
    eachVoice({ voice: item.voice, profile: item.profile }, refVoice)
  }
  const missing: PackageMissing[] = []
  for (const [id, where] of libraryRefs)
    if (!libRows.has(id)) missing.push({ kind: 'library', id, where })

  // 素材：只带自己名下、文件还在的；明确引用却找不到的记为缺失，参数里碰巧像资产 id 的值找不到就忽略
  const packageAssets: PackageAsset[] = []
  let bytes = 0
  for (const [id, ref] of assetRefs) {
    const asset = store.get(owner, id)
    const file = store.originalPath(id)
    const info = asset && (await stat(file).catch(() => null))
    if (!asset || !info?.isFile()) {
      if (ref.explicit) missing.push({ kind: 'asset', id, where: ref.where })
      continue
    }
    const path = `assets/${id}`
    files.set(path, file)
    bytes += info.size
    packageAssets.push({
      id,
      kind: asset.kind,
      mime: asset.mime,
      name: asset.name,
      size: info.size,
      width: asset.width,
      height: asset.height,
      duration: asset.duration,
      createdAt: asset.createdAt,
      file: { path, sha256: id, size: info.size },
    })
  }

  // 运行记录：只作历史。调用日志里有远端任务号和结果地址，不导出；运行中的改成已取消
  const canvasIds = rows.map((r) => r.id)
  const jobRows = canvasIds.length
    ? db
        .select()
        .from(jobs)
        .where(and(eq(jobs.owner_id, owner), inArray(jobs.canvas_id, canvasIds)))
        .orderBy(asc(jobs.created_at))
        .all()
    : []
  let history: PackageFile | null = null
  if (jobRows.length) {
    const list: PackageJob[] = jobRows.map((j) => {
      const active = j.status === 'queued' || j.status === 'running'
      return {
        id: j.id,
        canvasId: j.canvas_id,
        nodeId: j.node_id,
        nodeType: j.node_type,
        status: active ? 'canceled' : (j.status as PackageJob['status']),
        attempts: j.attempts,
        cacheKey: j.cache_key,
        cacheOmit: j.cache_omit,
        ...(j.input ? { input: JSON.parse(scrub(j.input)) as unknown } : {}),
        error: active ? RUNNING_NOTE : j.error && scrub(j.error),
        createdAt: j.created_at,
        startedAt: j.started_at,
        finishedAt: active ? Date.now() : j.finished_at,
      }
    })
    const data = strToU8(JSON.stringify(list))
    blobs.set(HISTORY, data)
    history = { path: HISTORY, sha256: sha(data), size: data.byteLength }
  }

  const manifest: ProjectPackageManifest = {
    format: PROJECT_PACKAGE_FORMAT,
    formatVersion: packageCheckpoints.length ? PROJECT_PACKAGE_VERSION : 1,
    createdAt: Date.now(),
    candidates,
    project: { id: project.id, title: project.title, createdAt: project.created_at },
    canvases: packageCanvases,
    checkpoints: packageCheckpoints,
    assets: packageAssets,
    library,
    history,
    dependencies: {
      models: [...models].sort(),
      voices: [...voices.values()],
      nodes: [...nodes.values()],
    },
    missing,
  }
  for (const b of blobs.values()) bytes += b.byteLength
  return { title: project.title, manifest, blobs, files, jobs: jobRows.length, bytes }
}

export async function packageSummary(
  deps: PackageDeps,
  owner: string,
  projectId: string,
  candidates: PackageCandidates,
): Promise<ProjectPackageSummary | null> {
  const plan = await planExport(deps, owner, projectId, candidates)
  if (!plan) return null
  const { manifest: m } = plan
  return {
    candidates,
    canvases: m.canvases.length,
    checkpoints: m.checkpoints.length,
    assets: m.assets.length,
    library: m.library.length,
    jobs: plan.jobs,
    bytes: plan.bytes,
    missing: m.missing,
    tooLarge: plan.bytes > PACKAGE_LIMIT,
  }
}

/** 导出项目包：返回 zip 流；项目不存在时返回 null，超过上限抛 PackageTooLargeError */
export async function exportProject(
  deps: PackageDeps,
  owner: string,
  projectId: string,
  candidates: PackageCandidates,
): Promise<{ stream: Readable; name: string } | null> {
  const plan = await planExport(deps, owner, projectId, candidates)
  if (!plan) return null
  if (plan.bytes > PACKAGE_LIMIT)
    throw new PackageTooLargeError('项目包超过 4 GB：可以不带历史候选再导出，或者整目录备份')
  const out = new PassThrough()
  const zip = new Zip((err, data, final) => {
    if (err) out.destroy(err)
    else {
      out.write(data)
      if (final) out.end()
    }
  })
  void (async () => {
    const text = (path: string, data: Uint8Array) => {
      const entry = new ZipDeflate(path, { level: 6 })
      zip.add(entry)
      entry.push(data, true)
    }
    text(MANIFEST, strToU8(JSON.stringify(plan.manifest, null, 2)))
    for (const [path, data] of plan.blobs) text(path, data)
    // 素材多半已经压缩过（图片、视频），原样存进去
    for (const [path, file] of plan.files) {
      const entry = new ZipPassThrough(path)
      zip.add(entry)
      for await (const chunk of createReadStream(file)) {
        entry.push(chunk as Uint8Array)
        if (out.writableNeedDrain) await once(out, 'drain')
      }
      entry.push(new Uint8Array(0), true)
    }
    zip.end()
  })().catch((err: Error) => out.destroy(err))
  return { stream: out, name: safeName(plan.title) }
}

// ── 导入 ──────────────────────────────────────────────

interface Pending {
  owner: string
  dir: string
  manifest: ProjectPackageManifest
  /** 包内路径 → 暂存区里校验过的文件 */
  staged: Map<string, string>
  docs: Map<string, Uint8Array>
  jobs: PackageJob[]
  checkpoints: Map<string, CheckpointArchive>
  expires: number
}

const pending = new Map<string, Pending>()

async function dropPending(token: string) {
  const p = pending.get(token)
  if (!p) return
  pending.delete(token)
  await rm(p.dir, { recursive: true, force: true })
}

async function sweep() {
  const now = Date.now()
  for (const [token, p] of pending) if (p.expires < now) await dropPending(token)
}

const list = (items: string[], max = 5) =>
  items.slice(0, max).join('、') + (items.length > max ? ` 等 ${items.length} 项` : '')

const reexport = '请在原设备上重新导出后再导入'

/** 读出一个条目，限制字节数并计算哈希 */
async function extract(
  pkg: string,
  entry: ZipEntry,
  dest: string | null,
  limit: number,
): Promise<{ sha256: string; size: number; data?: Uint8Array }> {
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let size = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > limit) return cb(new PackageError('hash_mismatch', `${entry.name} 比清单里写的大`))
      hash.update(chunk)
      if (!dest) chunks.push(chunk)
      cb(null, dest ? chunk : undefined)
    },
  })
  const src = await openZipEntry(pkg, entry)
  if (dest) await pipeline(src, counter, createWriteStream(dest))
  else {
    counter.resume()
    await pipeline(src, counter)
  }
  return { sha256: hash.digest('hex'), size, ...(dest ? {} : { data: Buffer.concat(chunks) }) }
}

/** 一个依赖在本机的状态 */
function modelStatus(host: PluginHost, ref: string): DependencyStatus {
  const parsed = parseModelRef(ref)
  const entry = parsed && host.registry.providers.get(parsed.provider)
  if (!parsed || !entry || !entry.def.models.some((m) => m.id === parsed.model)) return 'missing'
  return host.configs.get(parsed.provider).enabled ? 'ok' : 'disabled'
}

function voiceStatus(host: PluginHost, provider: string): DependencyStatus {
  if (!provider) return 'unverified'
  if (!host.registry.providers.has(provider)) return 'missing'
  if (!host.configs.get(provider).enabled) return 'disabled'
  // 复刻 / 设计的音色属于平台账户，只能在用的时候知道还在不在
  return 'unverified'
}

function nodeStatus(host: PluginHost, type: string, version: number): DependencyStatus {
  const latest = host.registry.latestNode(type)
  if (!latest) return 'missing'
  return latest.def.version < version ? 'outdated' : 'ok'
}

/**
 * 和本机已有记录冲突的 id，确认导入时据此换新。
 * 不属于这个项目的资产库条目（全局条目或别的项目的），本机同一所有者已有同 id 的直接复用，
 * 不换新也不再写一份：反复导入不在资产库里堆出重复条目
 */
function conflicts(
  deps: PackageDeps,
  owner: string,
  m: ProjectPackageManifest,
  jobList: PackageJob[],
) {
  const { db } = deps
  const ids = <T extends { id: string }>(rows: T[]) => new Set(rows.map((r) => r.id))
  const project = Boolean(
    db.select({ id: projects.id }).from(projects).where(eq(projects.id, m.project.id)).get(),
  )
  const canvasIds = m.canvases.map((c) => c.id)
  const canvasHit = canvasIds.length
    ? ids(
        db.select({ id: canvases.id }).from(canvases).where(inArray(canvases.id, canvasIds)).all(),
      )
    : new Set<string>()
  for (const id of canvasIds) if (deps.rooms.wasDropped(id)) canvasHit.add(id)
  const libIds = m.library.map((l) => l.id)
  const libRows = libIds.length
    ? db
        .select({ id: libraryItems.id, owner: libraryItems.owner_id })
        .from(libraryItems)
        .where(inArray(libraryItems.id, libIds))
        .all()
    : []
  const shared = new Set(m.library.filter((l) => l.projectId !== m.project.id).map((l) => l.id))
  const libReused = new Set(
    libRows.filter((r) => r.owner === owner && shared.has(r.id)).map((r) => r.id),
  )
  const libHit = new Set(libRows.filter((r) => !libReused.has(r.id)).map((r) => r.id))
  const jobHit = new Set<string>()
  for (let i = 0; i < jobList.length; i += 500) {
    const chunk = jobList.slice(i, i + 500).map((j) => j.id)
    for (const r of db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, chunk)).all())
      jobHit.add(r.id)
  }
  return {
    project,
    canvases: canvasHit,
    library: libHit,
    libraryReused: libReused,
    jobs: jobHit,
  }
}

/**
 * 预检：把包写进暂存区，校验格式版本、条目路径、文件哈希与大小，解析清单、文档和运行记录。
 * 任何一项不过都抛 PackageError（暂存区已清理）；通过时返回预检结果，确认前不写数据库。
 */
export async function inspectPackage(
  deps: PackageDeps,
  owner: string,
  body: Readable,
): Promise<ProjectImportPreview> {
  await sweep()
  const dir = await deps.assets.tempDir('import-')
  try {
    const pkg = join(dir, 'package.plein')
    let received = 0
    await pipeline(
      body,
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length
          if (received > PACKAGE_LIMIT)
            return cb(new PackageError('corrupt', '文件超过 4 GB，不是 Plein 导出的项目包'))
          cb(null, chunk)
        },
      }),
      createWriteStream(pkg),
    )

    let entries: ZipEntry[]
    try {
      entries = await readZipIndex(pkg)
    } catch (err) {
      if (!(err instanceof ZipError)) throw err
      const broken = /目录损坏|越界|条目|不完整/.test(err.message)
      throw new PackageError(
        broken ? 'corrupt' : 'not_a_package',
        broken
          ? `项目包已损坏（${err.message}），可能是下载或拷贝不完整，${reexport}`
          : `这不是 Plein 项目包（${err.message}）。请选择导出得到的 .plein 文件`,
      )
    }
    const unsafe = entries.filter((e) => !safeEntryName(e.name)).map((e) => e.name)
    if (unsafe.length)
      throw new PackageError(
        'unsafe_path',
        `项目包里有越出包目录的路径（${list(unsafe)}），已拒绝导入。请只导入可信来源的项目包`,
      )
    const byName = new Map<string, ZipEntry>()
    for (const e of entries) {
      if (byName.has(e.name))
        throw new PackageError('corrupt', `项目包里 ${e.name} 出现了两次，${reexport}`)
      byName.set(e.name, e)
    }
    const manifestEntry = byName.get(MANIFEST)
    if (!manifestEntry)
      throw new PackageError(
        'not_a_package',
        '压缩包里没有 manifest.json，不是 Plein 项目包。请选择导出得到的 .plein 文件',
      )

    let raw: unknown
    try {
      const { data } = await extract(pkg, manifestEntry, null, MANIFEST_LIMIT)
      raw = JSON.parse(new TextDecoder().decode(data))
    } catch (err) {
      if (err instanceof PackageError)
        throw new PackageError(
          'corrupt',
          `manifest.json 超过 ${MANIFEST_LIMIT / 1024 / 1024} MB，不是 Plein 导出的清单，${reexport}`,
        )
      throw new PackageError('corrupt', `manifest.json 读不出来，${reexport}`)
    }
    const head = raw as { format?: unknown; formatVersion?: unknown } | null
    if (head?.format !== PROJECT_PACKAGE_FORMAT)
      throw new PackageError(
        'not_a_package',
        'manifest.json 不是 Plein 项目包的清单。请选择导出得到的 .plein 文件',
      )
    if (typeof head.formatVersion === 'number' && head.formatVersion > PROJECT_PACKAGE_VERSION)
      throw new PackageError(
        'unsupported_version',
        `项目包格式版本 ${head.formatVersion} 高于本机支持的 ${PROJECT_PACKAGE_VERSION}，请把 Plein 升级到最新版本后再导入`,
      )
    const parsed = ProjectPackageManifest.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new PackageError(
        'corrupt',
        `清单内容不合法（${issue?.path.join('.') || '根'}：${issue?.message}），${reexport}`,
      )
    }
    const manifest = parsed.data
    checkManifest(manifest)

    // 逐个文件：在包里、大小和哈希都对得上
    const declared: PackageFile[] = [
      ...manifest.canvases.map((c) => c.file),
      ...manifest.checkpoints.map((c) => c.file),
      ...manifest.assets.map((a) => a.file),
      ...(manifest.history ? [manifest.history] : []),
    ]
    const absent = declared.filter((f) => !byName.has(f.path)).map((f) => f.path)
    if (absent.length)
      throw new PackageError(
        'missing_file',
        `项目包不完整，缺少 ${absent.length} 个文件（${list(absent)}），${reexport}`,
      )
    await mkdir(join(dir, 'files'))
    const staged = new Map<string, string>()
    const blobs = new Map<string, Uint8Array>()
    const mismatched: string[] = []
    for (const [i, f] of declared.entries()) {
      const entry = byName.get(f.path)!
      const inMemory = !f.path.startsWith('assets/')
      const dest = inMemory ? null : join(dir, 'files', String(i))
      try {
        const got = await extract(pkg, entry, dest, f.size)
        if (got.sha256 !== f.sha256 || got.size !== f.size) mismatched.push(f.path)
        else if (got.data) blobs.set(f.path, got.data)
        else if (dest) staged.set(f.path, dest)
      } catch (err) {
        if (err instanceof PackageError) mismatched.push(f.path)
        else if (err instanceof ZipError || (err as { code?: string }).code?.startsWith('Z_'))
          mismatched.push(f.path)
        else throw err
      }
    }
    if (mismatched.length)
      throw new PackageError(
        'hash_mismatch',
        `${mismatched.length} 个文件和清单里的校验值对不上（${list(mismatched)}），项目包可能已损坏或被改动，${reexport}`,
      )
    await rm(pkg, { force: true })

    // 文档能解析；版本高于本机时只读打开
    const docs = new Map<string, Uint8Array>()
    let newer = 0
    for (const c of manifest.canvases) {
      const data = blobs.get(c.file.path)!
      const ydoc = new Y.Doc()
      try {
        Y.applyUpdate(ydoc, data)
        const doc = createDoc(ydoc, { schedule: () => {} })
        if (doc.readOnly) newer++
        doc.destroy()
      } catch {
        throw new PackageError('corrupt', `画布「${c.title}」的文档已损坏，${reexport}`)
      } finally {
        ydoc.destroy()
      }
      docs.set(c.id, data)
    }
    let jobList: PackageJob[] = []
    if (manifest.history) {
      const res = z.array(PackageJob).safeParse(
        (() => {
          try {
            return JSON.parse(new TextDecoder().decode(blobs.get(manifest.history!.path)))
          } catch {
            return null
          }
        })(),
      )
      if (!res.success) throw new PackageError('corrupt', `运行记录读不出来，${reexport}`)
      const canvasIds = new Set(manifest.canvases.map((c) => c.id))
      jobList = res.data.filter((j) => canvasIds.has(j.canvasId))
    }

    const checkpoints = new Map<string, CheckpointArchive>()
    for (const checkpoint of manifest.checkpoints) {
      try {
        const archive = parseCheckpointArchive(
          JSON.parse(new TextDecoder().decode(blobs.get(checkpoint.file.path))),
        )
        checkpoints.set(checkpoint.id, archive)
      } catch {
        throw new PackageError('corrupt', `检查点「${checkpoint.name}」内容已损坏，${reexport}`)
      }
    }

    const token = randomUUID()
    const expires = Date.now() + PENDING_TTL
    pending.set(token, { owner, dir, manifest, staged, docs, jobs: jobList, checkpoints, expires })

    const hit = conflicts(deps, owner, manifest, jobList)
    const { host } = deps
    const notices = [
      '平台密钥、登录信息和智能体会话不在项目包里；导入后在设置里启用可用的平台，再按需重新选择模型和音色',
    ]
    if (jobList.length)
      notices.push(`${jobList.length} 条运行记录只作历史保留：导入后不会续查或重新提交任何任务`)
    if (manifest.candidates === 'current')
      notices.push('导出时只带了每个节点当前采用的结果，没有历史候选')
    if (newer) notices.push(`${newer} 张画布来自更新版本的 Plein，导入后只读打开`)
    if (manifest.checkpoints.length)
      notices.push(`${manifest.checkpoints.length} 个命名检查点和它们引用的素材会完整迁入`)
    return {
      token,
      expiresAt: expires,
      formatVersion: manifest.formatVersion,
      title: manifest.project.title,
      candidates: manifest.candidates,
      counts: {
        canvases: manifest.canvases.length,
        checkpoints: manifest.checkpoints.length,
        assets: manifest.assets.length,
        library: manifest.library.length,
        jobs: jobList.length,
        bytes: declared.reduce((n, f) => n + f.size, 0),
      },
      copy: hit.project,
      remapped: {
        canvases: hit.canvases.size,
        library: hit.library.size,
        jobs: hit.jobs.size,
      },
      reusedLibrary: hit.libraryReused.size,
      models: manifest.dependencies.models.map((ref) => ({ ref, status: modelStatus(host, ref) })),
      voices: manifest.dependencies.voices.map((v) => ({
        ...v,
        status: voiceStatus(host, v.provider),
      })),
      nodes: manifest.dependencies.nodes.map((n) => ({
        ...n,
        status: nodeStatus(host, n.type, n.version),
      })),
      missing: manifest.missing,
      notices,
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

/** 清单内部一致：路径都在约定的位置、互不重复，id 不重复，素材文件就是它的哈希 */
function checkManifest(m: ProjectPackageManifest) {
  const bad: string[] = []
  const paths = new Set<string>()
  const use = (path: string, ok: boolean) => {
    if (!ok || paths.has(path) || !safeEntryName(path)) bad.push(path)
    paths.add(path)
  }
  for (const c of m.canvases) use(c.file.path, /^canvases\/\d{1,6}\.yjs$/.test(c.file.path))
  for (const c of m.checkpoints) use(c.file.path, /^checkpoints\/\d{1,6}\.json$/.test(c.file.path))
  for (const a of m.assets) use(a.file.path, a.file.path === `assets/${a.id}`)
  if (m.history) use(m.history.path, m.history.path === HISTORY)
  if (bad.length)
    throw new PackageError(
      'unsafe_path',
      `清单里有不在约定位置的文件路径（${list(bad)}），已拒绝导入。请只导入可信来源的项目包`,
    )
  const dup = (ids: string[]) => new Set(ids).size !== ids.length
  if (
    dup(m.canvases.map((c) => c.id)) ||
    dup(m.checkpoints.map((c) => c.id)) ||
    dup(m.assets.map((a) => a.id)) ||
    dup(m.library.map((l) => l.id)) ||
    m.assets.some((a) => a.file.sha256 !== a.id || a.file.size !== a.size)
  )
    throw new PackageError('corrupt', `清单里有重复的记录或对不上的素材信息，${reexport}`)
}

/** 预检后放弃导入：删掉暂存区 */
export async function discardImport(owner: string, token: string) {
  const p = pending.get(token)
  if (!p || p.owner !== owner) return false
  await dropPending(token)
  return true
}

/** 画布文档里的引用跟着换新 id：参数里的资产库条目 id、运行状态与结果的 runId；运行中状态改成历史 */
export function remapDoc(data: Uint8Array, map: ReadonlyMap<string, string>): Uint8Array {
  const ydoc = new Y.Doc()
  try {
    Y.applyUpdate(ydoc, data)
    const elements = ydoc.getMap<Y.Map<unknown>>('elements')
    ydoc.transact(() => {
      for (const m of elements.values()) {
        if (!(m instanceof Y.Map)) continue
        const params = m.get('params')
        if (params instanceof Y.Map) {
          for (const [k, v] of params.entries()) {
            const next = remapValue(v, map)
            if (next !== v) params.set(k, next)
          }
        }
        const results = m.get('results')
        if (Array.isArray(results)) {
          const next = (results as NodeResult[]).map((r) =>
            r && typeof r === 'object' && map.has(r.runId) ? { ...r, runId: map.get(r.runId)! } : r,
          )
          if (next.some((r, i) => r !== results[i])) m.set('results', next)
        }
        const run = m.get('run') as NodeRun | undefined
        if (run && typeof run === 'object' && typeof run.status === 'string') {
          let next = settledRun(run, RUNNING_NOTE)
          if (map.has(next.id)) next = { ...next, id: map.get(next.id)! }
          if (next !== run) m.set('run', next)
        }
      }
    })
    return Y.encodeStateAsUpdate(ydoc)
  } finally {
    ydoc.destroy()
  }
}

/**
 * 确认导入：重新检查冲突并决定 id 映射，素材进内容存储，然后在一个事务里写入
 * 素材记录、项目、画布与文档、资产库条目和运行记录。暂存区随后删除。
 */
export async function commitImport(
  deps: PackageDeps,
  owner: string,
  token: string,
): Promise<ProjectImportResult | null> {
  const p = pending.get(token)
  if (!p || p.owner !== owner || p.expires < Date.now()) return null
  // 同一个令牌只能确认一次，并发的第二次当作不存在
  pending.delete(token)
  try {
    const { db, assets: store } = deps
    const m = p.manifest
    const hit = conflicts(deps, owner, m, p.jobs)
    const map = new Map<string, string>()
    const projectId = hit.project ? newProjectId() : m.project.id
    if (hit.project) map.set(m.project.id, projectId)
    // 作为副本导入时一律换新，保证和原项目没有任何共用的 id
    for (const c of m.canvases)
      if (hit.project || hit.canvases.has(c.id)) map.set(c.id, newCanvasId())
    // 作为副本时项目自己的条目也换新；共享条目本机已有的直接复用
    for (const l of m.library)
      if (hit.library.has(l.id) || (hit.project && !hit.libraryReused.has(l.id)))
        map.set(l.id, `lib_${randomBytes(9).toString('base64url')}`)
    for (const j of p.jobs)
      if (hit.project || hit.jobs.has(j.id))
        map.set(j.id, `run_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`)
    const checkpointIds = new Map<string, string>()
    for (const checkpoint of m.checkpoints) {
      const exists = db.$client
        .prepare('SELECT id FROM canvas_checkpoints WHERE id=?')
        .get(checkpoint.id)
      checkpointIds.set(
        checkpoint.id,
        exists || hit.project ? `cp_${randomBytes(12).toString('base64url')}` : checkpoint.id,
      )
    }
    const id = (old: string) => map.get(old) ?? old

    const placed: Asset[] = []
    for (const a of m.assets) {
      const file = p.staged.get(a.file.path)!
      if (store.get(owner, a.id)) continue
      const asset = await store.place(file, a.id, a.size, { mime: a.mime, name: a.name })
      placed.push({
        ...asset,
        width: asset.width ?? a.width,
        height: asset.height ?? a.height,
        duration: asset.duration ?? a.duration,
        createdAt: a.createdAt,
      })
    }
    const docs = new Map(m.canvases.map((c) => [c.id, remapDoc(p.docs.get(c.id)!, map)]))

    const title = hit.project ? `${m.project.title}（副本）` : m.project.title
    const now = Date.now()
    db.transaction((tx) => {
      for (const a of placed) store.insert(tx, owner, a)
      tx.insert(projects)
        .values({
          id: projectId,
          owner_id: owner,
          title,
          created_at: m.project.createdAt,
          updated_at: now,
        })
        .run()
      for (const c of m.canvases) {
        tx.insert(canvases)
          .values({
            id: id(c.id),
            owner_id: owner,
            project_id: projectId,
            title: c.title,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          })
          .run()
        tx.insert(docUpdates)
          .values({ canvas_id: id(c.id), data: Buffer.from(docs.get(c.id)!), created_at: now })
          .run()
      }
      for (const l of m.library) {
        if (hit.libraryReused.has(l.id)) continue
        const { id: lid, kind, name, projectId: lp, favorite, createdAt, updatedAt, ...data } = l
        tx.insert(libraryItems)
          .values({
            id: id(lid),
            owner_id: owner,
            project_id: lp === m.project.id ? projectId : null,
            kind,
            name,
            data: JSON.stringify(data),
            favorite: favorite ? 1 : 0,
            created_at: createdAt,
            updated_at: updatedAt,
          })
          .run()
      }
      for (const j of p.jobs) {
        tx.insert(jobs)
          .values({
            id: id(j.id),
            owner_id: owner,
            canvas_id: id(j.canvasId),
            node_id: j.nodeId,
            node_type: j.nodeType,
            status: j.status,
            attempts: j.attempts,
            cache_key: j.cacheKey,
            cache_omit: j.cacheOmit,
            input: j.input === undefined ? null : JSON.stringify(j.input),
            error: j.error,
            created_at: j.createdAt,
            started_at: j.startedAt,
            finished_at: j.finishedAt ?? j.createdAt,
          })
          .run()
      }
      for (const checkpoint of m.checkpoints) {
        const archive = p.checkpoints.get(checkpoint.id)!
        const state = Buffer.from(remapDoc(Buffer.from(archive.state, 'base64'), map))
        const checkpointId = checkpointIds.get(checkpoint.id)!
        const history = archive.history.map((job) => ({
          ...job,
          id: id(job.id),
          canvasId: id(job.canvasId),
        }))
        const sourceCanvasId =
          checkpoint.sourceCanvasId && m.canvases.some((cv) => cv.id === checkpoint.sourceCanvasId)
            ? id(checkpoint.sourceCanvasId)
            : null
        db.$client
          .prepare(
            'INSERT INTO canvas_checkpoints(id,owner_id,project_id,source_canvas_id,source_canvas_title,name,state,history,created_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            checkpointId,
            owner,
            projectId,
            sourceCanvasId,
            checkpoint.sourceCanvasTitle,
            checkpoint.name,
            state,
            JSON.stringify(history),
            checkpoint.createdAt,
            sha(state),
          )
        const refs = checkpointAssetIds(state, (asset) => !!store.get(owner, asset))
        const pin = db.$client.prepare(
          'INSERT INTO checkpoint_assets(checkpoint_id,owner_id,asset_id) VALUES(?,?,?)',
        )
        for (const asset of refs.ids) pin.run(checkpointId, owner, asset)
        deps.mediaIndex?.refreshCheckpoint(checkpointId)
      }
      for (const canvas of m.canvases) deps.mediaIndex?.refreshCanvas(id(canvas.id))
      for (const job of p.jobs) deps.mediaIndex?.refreshJob(id(job.id))
      for (const library of m.library) deps.mediaIndex?.refreshLibrary(id(library.id))
    })
    const latest = [...m.canvases].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return { projectId, title, canvasId: latest ? id(latest.id) : null }
  } finally {
    await rm(p.dir, { recursive: true, force: true })
  }
}
