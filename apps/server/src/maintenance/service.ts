import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, renameSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import {
  MaintenanceSettings,
  type BackupRestored,
  type CleanupPreview,
  type CleanupResult,
  type DataSpace,
  type LocalBackup,
  type MaintenanceStatus,
} from '@plein/protocol'
import * as Y from 'yjs'
import { z } from 'zod'
import type { AssetStore } from '../assets/store'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { canvasState, documentReferences, readDocument } from '../media-index/references'
import { backupInfo, backupManifest, restoreBackup, writeBackup } from './backup'
import { atomicJson, assertInsideDataDir, filesIn, jsonFile, scanTree } from './files'

const DAY = 86_400_000
const TTL = 10 * 60_000
const HASH = /^[0-9a-f]{64}$/
const IDS = /^[0-9a-f-]{36}$/
const State = z.object({
  settings: MaintenanceSettings,
  lastAttemptAt: z.number().nullable().default(null),
  lastBackupAt: z.number().nullable().default(null),
  lastError: z.string().nullable().default(null),
  nextBackupAt: z.number().nullable().default(null),
})
const AssetRow = z.object({
  id: z.string().regex(HASH),
  owner_id: z.string(),
  kind: z.string(),
  mime: z.string(),
  name: z.string(),
  size: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(),
  variants: z.string(),
  created_at: z.number(),
})
type AssetRow = z.infer<typeof AssetRow>
const DiskFile = z.object({
  path: z.string().regex(/^assets\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9.-]+)?$/),
  bytes: z.number(),
  mtime: z.number(),
})
const Candidate = z.object({
  id: z.string().regex(HASH),
  rows: z.array(AssetRow).min(1),
  files: z.array(DiskFile),
})
type Candidate = z.infer<typeof Candidate>
const Trash = z.object({
  id: z.string().uuid(),
  createdAt: z.number(),
  expiresAt: z.number(),
  state: z.enum(['pending', 'ready']),
  items: z.array(Candidate),
})
type Trash = z.infer<typeof Trash>
type Plan = { preview: CleanupPreview; revision: string; candidates: Candidate[] }

export class MaintenanceError extends Error {
  constructor(
    readonly code:
      | 'maintenance_busy'
      | 'changed'
      | 'expired'
      | 'not_found'
      | 'invalid'
      | 'unreadable',
    message: string,
  ) {
    super(message)
  }
}

export interface MaintenanceDeps {
  db: DB
  rooms: Rooms
  assets: AssetStore
  dataDir: string
  /** 测试时推进时钟；生产使用 Date.now。 */
  now?: () => number
}

export async function createMaintenanceService(deps: MaintenanceDeps) {
  const service = new MaintenanceService(deps)
  await service.init()
  return service
}

/** 所有维护限定在本机模式；不依赖可重建的 media_sources 作为删除依据。 */
export class MaintenanceService {
  private root: string
  private state = State.parse({ settings: {} })
  private operation: MaintenanceStatus['running'] = null
  private plans = new Map<string, Plan>()
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private current: Promise<unknown> | null = null
  private now: () => number
  /** 符号链接与不可读目录的扫描结果；全量遍历有开销，短缓存并随维护操作失效。 */
  private symlinkReport: { at: number; symlinks: string[]; unreadableDirs: string[] } | null = null

  constructor(private deps: MaintenanceDeps) {
    this.root = join(deps.dataDir, 'maintenance')
    this.now = deps.now ?? Date.now
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    for (const dir of ['backups', 'trash', 'restored']) {
      const path = join(this.root, dir)
      await mkdir(path, { recursive: true, mode: 0o700 })
      await chmod(path, 0o700)
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          (/^\.[0-9a-f-]{36}\.part$/.test(entry.name) ||
            /^\.purging-[0-9a-f-]{36}$/.test(entry.name) ||
            /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.part$/.test(entry.name))
        )
          await rm(join(path, entry.name), { recursive: true, force: true })
      }
    }
    try {
      this.state = State.parse(await jsonFile(join(this.root, 'state.json')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.state.lastError = '维护设置读取失败，已使用默认设置；请重新保存。'
    }
    // 中断的回收操作先恢复，防止数据库或文档指向已移动的文件。
    for (const trash of await this.trashManifests())
      if (trash.state === 'pending') await this.restoreTrashFiles(trash)
    if (this.state.settings.autoBackup && this.state.nextBackupAt == null)
      this.state.nextBackupAt = this.now() + this.state.settings.intervalHours * 3_600_000
    await this.saveState()
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('[maintenance]', e))
    }, 60_000)
    this.timer.unref()
  }

  /** 等进行中的维护结束后才能关 SQLite；不会在进程关闭时再创建备份。 */
  async close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.current?.catch(() => {})
  }

  private saveState() {
    return atomicJson(join(this.root, 'state.json'), this.state)
  }
  private async perform<T>(
    kind: NonNullable<MaintenanceStatus['running']>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.closed || this.operation || this.deps.assets.activity.busy)
      throw new MaintenanceError('maintenance_busy', '素材正在写入或另一项维护尚未完成，请稍后重试')
    this.operation = kind
    const job = this.deps.assets.activity.exclusive(fn)
    this.current = job
    try {
      return await job
    } finally {
      this.operation = null
      this.current = null
      this.symlinkReport = null
    }
  }

  private async backupList(): Promise<LocalBackup[]> {
    const list: LocalBackup[] = []
    for (const entry of await readdir(join(this.root, 'backups'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !IDS.test(entry.name)) continue
      const dir = join(this.root, 'backups', entry.name)
      try {
        list.push(backupInfo(dir, await backupManifest(dir)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return list.sort((a, b) => b.createdAt - a.createdAt)
  }
  private async trashManifests(): Promise<Trash[]> {
    const list: Trash[] = []
    for (const entry of await readdir(join(this.root, 'trash'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !IDS.test(entry.name)) continue
      let value: Trash
      try {
        value = Trash.parse(await jsonFile(join(this.root, 'trash', entry.name, 'manifest.json')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (
        value.id !== entry.name ||
        value.items.some(
          (i) =>
            i.rows.some((r) => r.id !== i.id) ||
            i.files.some((f) => !f.path.startsWith(`assets/${i.id.slice(0, 2)}/${i.id}`)),
        )
      )
        throw new Error('回收站清单不合法')
      list.push(value)
    }
    return list.sort((a, b) => b.createdAt - a.createdAt)
  }

  async status(): Promise<MaintenanceStatus> {
    const report = await this.skippedSymlinks()
    return {
      ...this.state,
      running: this.operation,
      skippedSymlinks: report.symlinks,
      unreadableDirs: report.unreadableDirs,
      backups: await this.backupList(),
      trash: (await this.trashManifests()).map((t) => ({
        id: t.id,
        createdAt: t.createdAt,
        assets: t.items.length,
        bytes: t.items.reduce((n, i) => n + i.files.reduce((m, f) => m + f.bytes, 0), 0),
        expiresAt: t.expiresAt,
      })),
    }
  }

  /**
   * 数据目录里的符号链接与不可读目录：维护一律跳过，这里只把路径报给用户。
   * maintenance 下是应用自己的备份、回收站和恢复副本，不属于用户放置的条目。
   * 全量遍历有开销，结果缓存 60 秒；备份、清理、恢复等操作结束时由 perform 失效。
   */
  private async skippedSymlinks() {
    if (this.symlinkReport && this.now() - this.symlinkReport.at < 60_000) return this.symlinkReport
    const { symlinks, unreadableDirs } = await scanTree(this.deps.dataDir, '', ['maintenance'])
    this.symlinkReport = {
      at: this.now(),
      symlinks: [...symlinks].sort(),
      unreadableDirs: [...unreadableDirs].sort(),
    }
    return this.symlinkReport
  }

  async settings(input: MaintenanceSettings) {
    await this.perform('settings', async () => {
      this.state.settings = MaintenanceSettings.parse(input)
      this.state.nextBackupAt = this.state.settings.autoBackup
        ? this.now() + this.state.settings.intervalHours * 3_600_000
        : null
      await this.saveState()
      this.plans.clear()
    })
    return this.status()
  }

  async backup(): Promise<LocalBackup> {
    return this.perform('backup', async () => {
      this.state.lastAttemptAt = this.now()
      try {
        await this.saveState()
        const backup = await writeBackup({
          ...this.deps,
          root: join(this.root, 'backups'),
          now: this.now(),
        })
        this.state.lastBackupAt = backup.createdAt
        this.state.lastError = null
        this.state.nextBackupAt = this.state.settings.autoBackup
          ? this.now() + this.state.settings.intervalHours * 3_600_000
          : null
        await this.saveState()
        // 成功后才轮换，失败不触碰已有备份。
        for (const old of (await this.backupList())
          .filter((entry) => entry.id !== backup.id)
          .slice(this.state.settings.keepBackups - 1))
          await rm(old.path, { recursive: true, force: true })
        return backup
      } catch (error) {
        this.state.lastError = (error as Error).message
        this.state.nextBackupAt = this.state.settings.autoBackup
          ? this.now() + Math.min(15 * 60_000, this.state.settings.intervalHours * 3_600_000)
          : null
        await this.saveState()
        throw error
      }
    })
  }

  /** 调度可在测试中直接触发；忙时保留到期时间，下次再试，不抢占创作任务。 */
  async tick() {
    if (this.closed || this.operation || this.deps.assets.activity.busy) return
    if (this.state.settings.autoBackup && (this.state.nextBackupAt ?? Infinity) <= this.now()) {
      try {
        await this.backup()
      } catch {
        /* lastError 持久化并在设置里展示 */
      }
    }
    if (!this.closed && !this.operation && !this.deps.assets.activity.busy) {
      try {
        await this.purgeExpiredTrash()
      } catch (error) {
        this.state.lastError = `回收站维护失败：${(error as Error).message}`
        await this.saveState()
      }
    }
  }

  async restoreCopy(id: string): Promise<BackupRestored> {
    if (!IDS.test(id)) throw new MaintenanceError('invalid', '备份编号不合法')
    return this.perform('restore', async () => {
      const backup = (await this.backupList()).find((b) => b.id === id)
      if (!backup) throw new MaintenanceError('not_found', '备份不存在')
      const path = join(this.root, 'restored', randomUUID())
      const missingAssets = await restoreBackup(backup.path, path)
      return { path, restartRequired: true, missingAssets }
    })
  }

  /** 既包含库内写入，也包含50ms缓冲中的Yjs编辑和删除集。 */
  private revision() {
    const hash = createHash('sha256')
    hash.update(String(this.deps.assets.activity.generation))
    hash.update(
      JSON.stringify(this.deps.db.$client.prepare('SELECT total_changes() AS changes').get()),
    )
    hash.update(JSON.stringify(this.deps.db.$client.pragma('data_version')))
    for (const id of this.deps.rooms.loaded().sort())
      hash.update(id).update(Y.encodeSnapshot(Y.snapshot(this.deps.rooms.get(id).doc)))
    return hash.digest('hex')
  }

  private assertRevision(revision: string) {
    if (this.revision() !== revision)
      throw new MaintenanceError('changed', '数据已变化，尚未清理的素材已保留，请重新预检')
  }

  private async references() {
    const revision = this.revision()
    const refs = new Set<string>()
    const scan = (value: unknown) => {
      if (typeof value !== 'string') return
      for (const hit of value.matchAll(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g)) refs.add(hit[0])
    }
    const canvases = this.deps.db.$client.prepare('SELECT id FROM canvases').all() as Array<{
      id: string
    }>
    for (const row of canvases) {
      for (const ref of readDocument(
        canvasState(this.deps.db, this.deps.rooms, row.id),
        documentReferences,
      ))
        refs.add(ref.assetId)
      await setImmediate()
    }
    // 从事实表读取，而非可能处于回填、维修或陈旧状态的来源投影。
    const tables = this.deps.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    for (const { name } of tables) {
      if (
        ['assets', 'media_sources', 'media_index_meta', 'doc_updates'].includes(name) ||
        name.startsWith('sqlite_')
      )
        continue
      const escaped = name.replaceAll('"', '""')
      let count = 0
      for (const raw of this.deps.db.$client.prepare(`SELECT * FROM "${escaped}"`).iterate()) {
        const row = raw as Record<string, unknown>
        for (const value of Object.values(row)) scan(value)
        if (name === 'canvas_checkpoints' && row.state instanceof Uint8Array)
          for (const ref of readDocument(row.state, documentReferences)) refs.add(ref.assetId)
        if (++count % 100 === 0) await setImmediate()
      }
      await setImmediate()
    }
    // 识别journal属于持久任务事实：unknown/pending也必须保护，不能当缓存清理。
    // 传前缀而不是拼接绝对路径，subtitle-recognition 被换成链接时不会跟随。
    const journal = await filesIn(this.deps.dataDir, 'subtitle-recognition')
    // 引用扫描不完整就不能清理：漏读的 journal 可能让在用素材被当成未使用。
    if (journal.unreadableDirs.length)
      throw new MaintenanceError(
        'unreadable',
        `数据目录有不可读的子目录，为避免误删已停止清理：${journal.unreadableDirs.join('、')}`,
      )
    for (const file of journal.files) {
      if (file.path.endsWith('.json'))
        scan(JSON.stringify(await jsonFile(join(this.deps.dataDir, file.path))))
    }
    this.assertRevision(revision)
    return { refs, revision }
  }

  private async scan() {
    // 只为尚未发放token的读操作重建完整快照。50ms画布落盘也会改变revision；
    // 不能复用上一轮引用，或给cleanup的旧token刷新revision。
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.scanOnce()
      } catch (error) {
        if (!(error instanceof MaintenanceError) || error.code !== 'changed' || attempt >= 2)
          throw error
      }
    }
  }

  private async scanOnce() {
    if (this.deps.assets.activity.busy)
      throw new MaintenanceError('maintenance_busy', '素材正在写入，请稍后预检')
    const reference = await this.references()
    const rows = this.deps.db.$client
      .prepare('SELECT * FROM assets ORDER BY id,owner_id')
      .all() as AssetRow[]
    const disk = (await filesIn(this.deps.dataDir, 'assets')).files
    const cutoff = this.now() - this.state.settings.unusedDays * DAY
    const groups = new Map<string, Candidate>()
    for (const row of rows) {
      if (!HASH.test(row.id)) throw new Error('资产编号不合法，清理已停止')
      let item = groups.get(row.id)
      if (!item) {
        item = { id: row.id, rows: [], files: [] }
        groups.set(row.id, item)
      }
      item.rows.push(row)
    }
    for (const file of disk) {
      const id = file.path.split('/')[2]?.split('.')[0]
      if (id && DiskFile.safeParse(file).success) groups.get(id)?.files.push(file)
    }
    const candidates = [...groups.values()].filter(
      (item) =>
        !reference.refs.has(item.id) &&
        item.rows.every((r) => r.created_at < cutoff) &&
        item.files.length > 0 &&
        item.files.every((f) => f.mtime < cutoff),
    )
    this.assertRevision(reference.revision)
    return { ...reference, groups, disk, candidates }
  }

  async space(): Promise<DataSpace> {
    const scan = await this.scan()
    const files = (await filesIn(this.deps.dataDir)).files
    const out: DataSpace = {
      total: 0,
      database: 0,
      originals: 0,
      derivatives: 0,
      temporary: 0,
      backups: 0,
      trash: 0,
      restored: 0,
      other: 0,
      assets: scan.groups.size,
      referencedAssets: [...scan.groups.keys()].filter((id) => scan.refs.has(id)).length,
      unusedAssets: scan.candidates.length,
      reclaimableBytes: scan.candidates.reduce(
        (n, c) => n + c.files.reduce((m, f) => m + f.bytes, 0),
        0,
      ),
    }
    for (const file of files) {
      const kind = /^plein\.db(?:-|$)/.test(file.path)
        ? 'database'
        : file.path.startsWith('assets/')
          ? /\/[0-9a-f]{64}$/.test(file.path)
            ? 'originals'
            : 'derivatives'
          : file.path.startsWith('tmp/')
            ? 'temporary'
            : file.path.startsWith('maintenance/backups/')
              ? 'backups'
              : file.path.startsWith('maintenance/trash/')
                ? 'trash'
                : file.path.startsWith('maintenance/restored/')
                  ? 'restored'
                  : 'other'
      out.total += file.bytes
      out[kind] += file.bytes
    }
    return out
  }

  async preview(): Promise<CleanupPreview> {
    const scan = await this.scan()
    const token = randomUUID(),
      expiresAt = this.now() + TTL
    const preview: CleanupPreview = {
      token,
      expiresAt,
      assets: scan.candidates.length,
      bytes: scan.candidates.reduce((n, c) => n + c.files.reduce((m, f) => m + f.bytes, 0), 0),
      unusedDays: this.state.settings.unusedDays,
      protectedAssets: [...scan.groups.keys()].filter((id) => scan.refs.has(id)).length,
    }
    for (const [key, plan] of this.plans)
      if (plan.preview.expiresAt < this.now()) this.plans.delete(key)
    this.plans.set(token, { preview, revision: scan.revision, candidates: scan.candidates })
    return preview
  }

  async cleanup(token: string): Promise<CleanupResult> {
    const plan = this.plans.get(token)
    this.plans.delete(token)
    if (!plan || plan.preview.expiresAt < this.now())
      throw new MaintenanceError('expired', '预检已过期，请重新检查')
    return this.perform('cleanup', async () => {
      this.assertRevision(plan.revision)
      const id = randomUUID(),
        createdAt = this.now(),
        expiresAt = createdAt + this.state.settings.trashDays * DAY
      if (!plan.candidates.length) return { id: null, assets: 0, bytes: 0, expiresAt }
      const dir = join(this.root, 'trash', id)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const trash: Trash = { id, createdAt, expiresAt, state: 'pending', items: plan.candidates }
      await atomicJson(join(dir, 'manifest.json'), trash)
      try {
        // 目录预先异步建立；最终校验 + rename + 元数据事务之间不让出事件循环。
        for (const item of trash.items)
          for (const file of item.files)
            await mkdir(dirname(join(dir, file.path)), { recursive: true, mode: 0o700 })
        for (const item of trash.items) {
          await setImmediate()
          this.assertRevision(plan.revision)
          for (const file of item.files) {
            // 预检只是快照；真正移动前逐层确认源和回收站目标没有穿过链接。
            await assertInsideDataDir(this.deps.dataDir, file.path)
            await assertInsideDataDir(dir, file.path)
            const stat = lstatSync(join(this.deps.dataDir, file.path))
            if (!stat.isFile() || stat.size !== file.bytes || stat.mtimeMs !== file.mtime)
              throw new MaintenanceError('changed', '素材文件已变化，请重新预检')
          }
          this.deps.db.$client.transaction(() => {
            for (const file of item.files)
              renameSync(join(this.deps.dataDir, file.path), join(dir, file.path))
            this.deps.db.$client.prepare('DELETE FROM assets WHERE id=?').run(item.id)
            this.deps.db.$client.prepare('DELETE FROM media_sources WHERE asset_id=?').run(item.id)
          })()
          // 只接受本操作自己的元数据变更；外部编辑在下一个yield后仍会使校验失效。
          plan.revision = this.revision()
        }
        trash.state = 'ready'
        await atomicJson(join(dir, 'manifest.json'), trash)
        return { id, assets: trash.items.length, bytes: plan.preview.bytes, expiresAt }
      } catch (error) {
        await this.restoreTrashFiles(trash)
        throw error
      }
    })
  }

  private async restoreTrashFiles(trash: Trash) {
    const root = join(this.root, 'trash', trash.id)
    for (const item of trash.items)
      for (const file of item.files) {
        const source = join(root, file.path),
          target = join(this.deps.dataDir, file.path)
        // 必须在 mkdir 之前检查：穿过链接的 mkdir 本身就会在目录外落文件。
        await assertInsideDataDir(root, file.path)
        await assertInsideDataDir(this.deps.dataDir, file.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const sourceExists = await lstat(source).then(
          () => true,
          (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return false
            throw e
          },
        )
        if (sourceExists) {
          const targetExists = await lstat(target).then(
            () => true,
            (e: NodeJS.ErrnoException) => {
              if (e.code === 'ENOENT') return false
              throw e
            },
          )
          if (!targetExists) await rename(source, target)
        } else if (!existsSync(target)) throw new Error(`回收站和素材目录都缺少文件：${file.path}`)
      }
    this.deps.db.$client.transaction(() => {
      const insert = this.deps.db.$client.prepare(
        'INSERT OR IGNORE INTO assets(id,owner_id,kind,mime,name,size,width,height,duration,variants,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      for (const item of trash.items)
        for (const row of item.rows)
          insert.run(
            row.id,
            row.owner_id,
            row.kind,
            row.mime,
            row.name,
            row.size,
            row.width,
            row.height,
            row.duration,
            row.variants,
            row.created_at,
          )
    })()
    await rm(root, { recursive: true, force: true })
  }

  async restoreTrash(id: string) {
    return this.perform('restore', async () => {
      const trash = (await this.trashManifests()).find((t) => t.id === id)
      if (!trash) throw new MaintenanceError('not_found', '回收记录不存在')
      trash.state = 'pending'
      await atomicJson(join(this.root, 'trash', id, 'manifest.json'), trash)
      await this.restoreTrashFiles(trash)
      return { assets: trash.items.length }
    })
  }

  private async purgeExpiredTrash() {
    const expired = (await this.trashManifests()).filter((t) => t.expiresAt <= this.now())
    if (!expired.length) return
    await this.perform('cleanup', async () => {
      for (const trash of expired) {
        const snapshot = await this.references()
        if (trash.items.some((i) => snapshot.refs.has(i.id))) {
          await this.restoreTrashFiles(trash)
          continue
        }
        this.assertRevision(snapshot.revision)
        const source = join(this.root, 'trash', trash.id),
          target = join(this.root, 'trash', `.purging-${trash.id}`)
        // 删除同样不越过链接：回收站路径可能整目录被换成指向外部的链接。
        await assertInsideDataDir(this.deps.dataDir, `maintenance/trash/${trash.id}`)
        await assertInsideDataDir(this.deps.dataDir, `maintenance/trash/.purging-${trash.id}`)
        renameSync(source, target)
        await rm(target, { recursive: true, force: true })
      }
    })
  }
}
