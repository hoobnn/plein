import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDoc } from '@plein/doc'
import { normalizeLibraryImages } from '@plein/nodes'
import {
  type Asset,
  PackageJob,
  type PackageFile,
  PROJECT_PACKAGE_FORMAT,
  PROJECT_PACKAGE_VERSION,
  ProjectPackageManifest,
  type ProjectImportPreview,
  type ProjectImportResult,
} from '@plein/protocol'
import { z } from 'zod'
import * as Y from 'yjs'
import {
  checkpointAssetIds,
  parseCheckpointArchive,
  type CheckpointArchive,
} from '../checkpoints/archive'
import {
  compositionReferences,
  libraryCompositionReferences,
  readDocument,
} from '../media-index/references'
import { newCanvasId, newProjectId } from '../storage/canvases'
import { openZipEntry, readZipIndex, safeEntryName, ZipError, type ZipEntry } from './zip'
import {
  HISTORY,
  MANIFEST,
  MANIFEST_LIMIT,
  PACKAGE_LIMIT,
  PackageError,
  sha,
  type PackageDeps,
} from './package-types'
import { PackageStore } from './package-store'
import { modelStatus, nodeStatus, voiceStatus } from './package-deps'
import { remapDoc } from './package-remap'
import {
  dropPending,
  getPending,
  stagePending,
  sweep,
  takePending,
  PENDING_TTL,
} from './package-staging'

/**
 * 项目包的导入：先把包放进暂存区，校验版本、路径、哈希并解析文档，返回预检结果；
 * 确认后素材先进内容存储（按哈希寻址，多出来也不影响什么），数据库记录在一个事务里写入，
 * 失败时不留下半个项目。
 */

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
  const db = new PackageStore(deps.db)
  const project = db.projectExists(m.project.id)
  const canvasIds = m.canvases.map((c) => c.id)
  const canvasHit = db.existingCanvasIds(canvasIds)
  for (const id of canvasIds) if (deps.rooms.wasDropped(id)) canvasHit.add(id)
  const libIds = m.library.map((l) => l.id)
  const libRows = db.libraryOwners(libIds)
  const shared = new Set(m.library.filter((l) => l.projectId !== m.project.id).map((l) => l.id))
  const libReused = new Set(
    libRows.filter((r) => r.owner === owner && shared.has(r.id)).map((r) => r.id),
  )
  const libHit = new Set(libRows.filter((r) => !libReused.has(r.id)).map((r) => r.id))
  const jobHit = db.existingJobIds(jobList.map((j) => j.id))
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

    const availableSources = new Set(manifest.assets.map((asset) => asset.id))
    for (const item of manifest.library) {
      if (libraryCompositionReferences(item).some((id) => !availableSources.has(id)))
        throw new PackageError(
          'missing_file',
          `资产库中的动态合成源工程或依赖未包含在项目包中，${reexport}`,
        )
    }

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
        try {
          const available = new Set(manifest.assets.map((asset) => asset.id))
          if (compositionReferences(doc).some((id) => !available.has(id)))
            throw new PackageError(
              'missing_file',
              `动态合成源工程或依赖未包含在项目包中，${reexport}`,
            )
        } finally {
          doc.destroy()
        }
      } catch (error) {
        if (error instanceof PackageError) throw error
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
        readDocument(Buffer.from(archive.state, 'base64'), (doc) => {
          const available = new Set(manifest.assets.map((asset) => asset.id))
          if (compositionReferences(doc).some((id) => !available.has(id)))
            throw new PackageError(
              'missing_file',
              `检查点中的动态合成源工程或依赖未包含在项目包中，${reexport}`,
            )
        })
        checkpoints.set(checkpoint.id, archive)
      } catch (error) {
        if (error instanceof PackageError) throw error
        throw new PackageError('corrupt', `检查点「${checkpoint.name}」内容已损坏，${reexport}`)
      }
    }

    const token = randomUUID()
    const expires = Date.now() + PENDING_TTL
    stagePending(token, { owner, dir, manifest, staged, docs, jobs: jobList, checkpoints, expires })

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
  const p = getPending(token)
  if (!p || p.owner !== owner) return false
  await dropPending(token)
  return true
}

/**
 * 确认导入：重新检查冲突并决定 id 映射，素材进内容存储，然后在一个事务里写入
 * 素材记录、项目、画布与文档、资产库条目和运行记录。暂存区随后删除。
 */
export function commitImport(
  deps: PackageDeps,
  owner: string,
  token: string,
): Promise<ProjectImportResult | null> {
  return deps.assets.activity.run(() => commitImportActive(deps, owner, token))
}

async function commitImportActive(
  deps: PackageDeps,
  owner: string,
  token: string,
): Promise<ProjectImportResult | null> {
  const p = getPending(token)
  if (!p || p.owner !== owner || p.expires < Date.now()) return null
  // 同一个令牌只能确认一次，并发的第二次当作不存在
  takePending(token)
  try {
    const { assets: store } = deps
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
    const db = new PackageStore(deps.db)
    const checkpointIds = new Map<string, string>()
    for (const checkpoint of m.checkpoints) {
      const exists = db.checkpointExists(checkpoint.id)
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
    deps.db.transaction((tx) => {
      for (const a of placed) store.insert(tx, owner, a)
      db.insertProject(tx, {
        id: projectId,
        owner_id: owner,
        title,
        created_at: m.project.createdAt,
        updated_at: now,
      })
      for (const c of m.canvases) {
        db.insertCanvas(tx, {
          id: id(c.id),
          owner_id: owner,
          project_id: projectId,
          title: c.title,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        })
        db.insertDocUpdate(tx, {
          canvas_id: id(c.id),
          data: Buffer.from(docs.get(c.id)!),
          created_at: now,
        })
      }
      for (const l of m.library) {
        if (hit.libraryReused.has(l.id)) continue
        const { id: lid, kind, name, projectId: lp, favorite, createdAt, updatedAt, ...data } = l
        db.insertLibraryItem(tx, {
          id: id(lid),
          owner_id: owner,
          project_id: lp === m.project.id ? projectId : null,
          kind,
          name,
          data: JSON.stringify({ ...data, images: normalizeLibraryImages(kind, data.images) }),
          favorite: favorite ? 1 : 0,
          created_at: createdAt,
          updated_at: updatedAt,
        })
      }
      for (const j of p.jobs) {
        db.insertJob(tx, {
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
        db.insertCheckpoint({
          id: checkpointId,
          owner_id: owner,
          project_id: projectId,
          source_canvas_id: sourceCanvasId,
          source_canvas_title: checkpoint.sourceCanvasTitle,
          name: checkpoint.name,
          state,
          history: JSON.stringify(history),
          created_at: checkpoint.createdAt,
          content_hash: sha(state),
        })
        const refs = checkpointAssetIds(state, (asset) => !!store.get(owner, asset))
        db.insertCheckpointAssets(checkpointId, owner, refs.ids)
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
