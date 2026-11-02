import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { once } from 'node:events'
import { PassThrough, type Readable } from 'node:stream'
import {
  compositionAssetIds,
  continuityAssets,
  createDoc,
  sequenceSegmentAssets,
  adoptedResultIds,
  type CanvasElement,
} from '@plein/doc'
import {
  normalizeLibraryImages,
  characterAssetTargetOf,
  sceneViewAssets,
  SHOT_ANALYSIS_TYPE,
  shotAnalysisAssets,
  DELIVERY_CHECK_TYPE,
  deliveryCheckAssets,
  isAiAnalysisType,
  aiAnalysisAssets,
} from '@plein/nodes'
import {
  derivationAssets,
  type LibraryItem,
  type PackageAsset,
  type PackageCandidates,
  type PackageCanvas,
  type PackageCheckpoint,
  type PackageFile,
  type PackageJob,
  type PackageLibraryItem,
  type PackageMissing,
  PROJECT_PACKAGE_FORMAT,
  PROJECT_PACKAGE_VERSION,
  ProjectPackageManifest,
  type ProjectPackageSummary,
} from '@plein/protocol'
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import * as Y from 'yjs'
import { safeName } from '../assets/interchange'
import { checkpointArchive, checkpointRows } from '../checkpoints/archive'
import {
  compositionReferences,
  documentReferences,
  libraryCompositionReferences,
  readDocument,
} from '../media-index/references'
import {
  ASSET_ID,
  HISTORY,
  MANIFEST,
  PACKAGE_LIMIT,
  RUNNING_NOTE,
  PackageError,
  PackageTooLargeError,
  pathScrubber,
  settledRun,
  sha,
  type PackageDeps,
} from './package-types'
import { PackageStore } from './package-store'

/**
 * 项目包的导出：重放画布文档到一份副本上，按候选范围裁剪结果、把运行中状态改成历史，
 * 收集文档引用到的素材、资产库条目和外部依赖，流式写成 zip。
 */

/** 整理导出要打包的全部内容；项目不存在时返回 null */
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

function loadState(store: PackageStore, deps: PackageDeps, canvasId: string): Y.Doc {
  const ydoc = new Y.Doc()
  // 已经打开的房间可能有还没落盘的增量，直接取内存里的文档
  if (deps.rooms.has(canvasId)) {
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(deps.rooms.get(canvasId).doc))
    return ydoc
  }
  for (const r of store.docUpdates(canvasId)) Y.applyUpdate(ydoc, new Uint8Array(r.data))
  return ydoc
}

/** 深度遍历 JSON 值，对每个字符串调用 fn */
function eachString(v: unknown, fn: (s: string) => void) {
  if (typeof v === 'string') fn(v)
  else if (Array.isArray(v)) for (const x of v) eachString(x, fn)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) eachString(x, fn)
}

function characterAssetLibrary(el: Pick<CanvasElement, 'nodeType' | 'params'>) {
  return characterAssetTargetOf(el)?.libraryId
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

/** 整理出要打包的全部内容；项目不存在时返回 null */
async function planExport(
  deps: PackageDeps,
  owner: string,
  projectId: string,
  candidates: PackageCandidates,
): Promise<ExportPlan | null> {
  const { assets: store, host } = deps
  const db = new PackageStore(deps.db)
  const project = db.project(owner, projectId)
  if (!project) return null
  const scrub = pathScrubber(deps.dataDir)
  const rows = db.projectCanvases(owner, projectId)

  const blobs = new Map<string, Uint8Array>()
  const files = new Map<string, string>()
  /** 资产 id → 第一次被引用的位置；explicit 表示是素材 / 结果 / 资产库图片这类明确的引用 */
  const assetRefs = new Map<string, { where: string; explicit: boolean }>()
  const compositionRefs = new Set<string>()
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
    const ydoc = loadState(db, deps, row.id)
    const doc = createDoc(ydoc, { schedule: () => {} })
    try {
      ydoc.transact(() => {
        for (const el of doc.elements()) {
          const where = `${row.title} / ${el.name ?? el.nodeType ?? el.kind}`
          const m = doc.mutable(el.id)!
          if (el.assetId) refAsset(el.assetId, where, true)
          for (const assetId of derivationAssets(el.params?.mediaDerivation))
            refAsset(assetId, `${where} / 加工来源`, true)
          for (const assetId of sequenceSegmentAssets(el))
            refAsset(assetId, `${where} / 固定剪辑素材`, true)
          if (el.kind === 'markdown')
            for (const assetId of aiAnalysisAssets(el.params?.aiDraftOrigin))
              refAsset(assetId, where, true)
          for (const assetId of continuityAssets(el.production?.continuity))
            refAsset(assetId, `${where} / 历史观察证据`, true)
          for (const subject of el.production?.continuity?.subjects ?? [])
            if (subject.binding?.libraryId)
              libraryRefs.set(subject.binding.libraryId, `${where} / 状态主体`)
          for (const delivery of el.deliveries ?? [])
            refAsset(delivery.assetId, `${where} / 交付 ${delivery.version}`, true)
          if (el.results?.length) {
            const adopted = adoptedResultIds(el)
            const kept =
              candidates === 'all' ? el.results : el.results.filter((r) => adopted.has(r.id))
            if (kept.length !== el.results.length) m.set('results', kept)
            for (const r of kept) {
              if ('assetId' in r.value) {
                refAsset(r.value.assetId, where, true)
                for (const id of compositionAssetIds(r.value.compositionSource))
                  refAsset(id, `${where} / 动态合成源工程`, true)
              } else if (el.nodeType === SHOT_ANALYSIS_TYPE && r.value.type === 'json')
                for (const assetId of shotAnalysisAssets(r.value.value))
                  refAsset(assetId, where, true)
              else if (el.nodeType === DELIVERY_CHECK_TYPE && r.value.type === 'json')
                for (const assetId of deliveryCheckAssets(r.value.value))
                  refAsset(assetId, where, true)
              else if (isAiAnalysisType(el.nodeType) && r.value.type === 'json')
                for (const assetId of aiAnalysisAssets(r.value.value))
                  refAsset(assetId, where, true)
            }
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
            if (el.nodeType === 'plein/scene')
              for (const assetId of sceneViewAssets(el.params.sceneViews))
                refAsset(assetId, `${where} / 场景视角`, true)
            eachVoice(el.params, refVoice)
            const { libraryId, model, voice } = el.params as Record<string, unknown>
            if (typeof libraryId === 'string' && libraryId) libraryRefs.set(libraryId, where)
            const characterLibraryId = characterAssetLibrary(el)
            if (characterLibraryId) libraryRefs.set(characterLibraryId, `${where} / 角色图片制作`)
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
      try {
        for (const id of compositionReferences(doc)) {
          compositionRefs.add(id)
          refAsset(id, `${row.title} / 动态合成源工程`, true)
        }
      } catch {
        throw new PackageError('corrupt', '动态合成来源信息无效，无法导出可编辑工程')
      }
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
  for (const [i, checkpoint] of checkpointRows(deps.db, owner, projectId).entries()) {
    // 命名保存的候选不能被当前画布的 current/all 选项删掉。
    readDocument(checkpoint.state, (doc) => {
      try {
        for (const id of compositionReferences(doc)) compositionRefs.add(id)
      } catch {
        throw new PackageError('corrupt', '检查点中的动态合成来源信息无效')
      }
      for (const ref of documentReferences(doc))
        refAsset(ref.assetId, `检查点 ${checkpoint.name} / ${ref.label}`, ref.explicit)
      for (const el of doc.elements()) {
        for (const subject of el.production?.continuity?.subjects ?? [])
          if (subject.binding?.libraryId)
            libraryRefs.set(subject.binding.libraryId, `检查点 / ${checkpoint.name} / 状态主体`)
        if (el.params) {
          eachVoice(el.params, refVoice)
          const { libraryId, model } = el.params
          if (typeof libraryId === 'string' && libraryId)
            libraryRefs.set(libraryId, `检查点 / ${checkpoint.name}`)
          const characterLibraryId = characterAssetLibrary(el)
          if (characterLibraryId)
            libraryRefs.set(characterLibraryId, `检查点 / ${checkpoint.name} / 角色图片制作`)
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
  const owned = db.ownedLibraryItems(owner, projectId)
  const referenced = libraryRefs.size
    ? db.referencedLibraryItems(owner, [...libraryRefs.keys()])
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
      images: normalizeLibraryImages(r.kind, d.images ?? []),
      video: d.video ?? null,
      ...(d.videoCompositionSource != null
        ? { videoCompositionSource: d.videoCompositionSource }
        : {}),
      models: d.models ?? [],
      profile: d.profile ?? null,
      sceneViews: d.sceneViews ?? [],
      coverAssetId: d.coverAssetId ?? null,
      favorite: r.favorite === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
    library.push(item)
    const where = `资产库 / ${r.name}`
    try {
      for (const id of libraryCompositionReferences(item)) {
        compositionRefs.add(id)
        refAsset(id, `${where} / 动态合成源工程`, true)
      }
    } catch {
      throw new PackageError('corrupt', '资产库中的动态合成来源信息无效')
    }
    eachString(
      {
        images: item.images,
        video: item.video,
        profile: item.profile,
        sceneViews: item.sceneViews,
        coverAssetId: item.coverAssetId,
      },
      (s) => {
        if (ASSET_ID.test(s)) refAsset(s, where, true)
      },
    )
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
      if (compositionRefs.has(id))
        throw new PackageError('missing_file', '动态合成源工程或依赖缺失，无法导出可编辑工程')
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
  const jobRows = canvasIds.length ? db.canvasJobs(owner, canvasIds) : []
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
