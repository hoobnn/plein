import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { LocalBackup } from '@plein/protocol'
import { storedOutputSpoolRefs, type OutputSpoolRef } from '../assets/output-spool'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { atomicJson, copyChecked, filesIn, hashFile, jsonFile, safeRelative, symlinksIn } from './files'

const File = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
const Manifest = z.object({
  format: z.literal('plein-local-backup'),
  version: z.literal(1),
  id: z.string().uuid(),
  createdAt: z.number(),
  /** 包含 SQLite 中的账户和会话，以及本机平台密钥；不可上传共享。 */
  containsCredentials: z.literal(true),
  files: z.array(File),
  /** 打包时遇到、未纳入备份的符号链接（相对数据目录）；旧清单没有该字段。 */
  skippedSymlinks: z.array(z.string()).default([]),
})
export type BackupManifest = z.infer<typeof Manifest>
const CONFIGS = new Set([
  'secret.json',
  'providers.json',
  'models.json',
  'plugins-state.json',
  'external-mcp.json',
])

function allowedPath(path: string) {
  return (
    safeRelative(path) &&
    (path === 'plein.db' ||
      CONFIGS.has(path) ||
      path.startsWith('plugins/') ||
      /^job-outputs\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        path,
      ) ||
      /^subtitle-recognition\/[A-Za-z0-9_-]+\.json$/.test(path) ||
      /^assets\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9.-]+)?$/.test(path))
  )
}

export async function backupManifest(dir: string): Promise<BackupManifest> {
  const parsed = Manifest.parse(await jsonFile(join(dir, 'manifest.json')))
  if (
    !parsed.files.some((f) => f.path === 'plein.db') ||
    new Set(parsed.files.map((f) => f.path)).size !== parsed.files.length ||
    parsed.files.some((f) => !allowedPath(f.path)) ||
    parsed.skippedSymlinks.some((path) => !safeRelative(path))
  )
    throw new Error('备份文件清单不合法')
  return parsed
}

export function backupInfo(dir: string, m: BackupManifest): LocalBackup {
  return {
    id: m.id,
    createdAt: m.createdAt,
    bytes: m.files.reduce((n, f) => n + f.bytes, 0),
    files: m.files.length,
    path: dir,
    skippedSymlinks: m.skippedSymlinks,
  }
}

/** SQLite 在线 backup 得到一致快照；文件流式校验，不把素材整份读入内存。 */
export async function writeBackup(deps: {
  db: DB
  rooms: Rooms
  dataDir: string
  root: string
  now: number
}) {
  const id = randomUUID()
  const part = join(deps.root, `.${id}.part`)
  const dest = join(deps.root, id)
  await mkdir(part, { recursive: true, mode: 0o700 })
  try {
    for (const canvasId of deps.rooms.loaded()) deps.rooms.get(canvasId).flush()
    await deps.db.$client.backup(join(part, 'plein.db'))
    await chmod(join(part, 'plein.db'), 0o600)
    const snapshot = new Database(join(part, 'plein.db'), { readonly: true })
    let assetIds: Set<string>
    let spoolRefs: OutputSpoolRef[]
    try {
      assetIds = new Set(
        (snapshot.prepare('SELECT DISTINCT id FROM assets').all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      )
      spoolRefs = await storedOutputSpoolRefs(snapshot, deps.dataDir)
    } finally {
      snapshot.close()
    }
    const files: BackupManifest['files'] = [
      {
        path: 'plein.db',
        bytes: (await lstat(join(part, 'plein.db'))).size,
        sha256: await hashFile(join(part, 'plein.db')),
      },
    ]
    const physical = await filesIn(join(deps.dataDir, 'assets'))
    const physicalPaths = new Set(physical.map((file) => file.path))
    // 遍历到的符号链接不打包也不让备份失败，只把路径记进清单供用户查看。
    const skippedSymlinks = (await symlinksIn(join(deps.dataDir, 'assets'))).map(
      (path) => `assets/${path}`,
    )
    for (const id of assetIds) {
      if (!physicalPaths.has(`${id.slice(0, 2)}/${id}`))
        throw new Error(`素材文件缺失，未生成不完整备份：${id}`)
    }
    for (const file of physical) {
      const id = file.path.split('/')[1]?.split('.')[0]
      if (!id || !assetIds.has(id) || !allowedPath(`assets/${file.path}`)) continue
      const path = `assets/${file.path}`
      const copied = await copyChecked(join(deps.dataDir, path), join(part, path))
      if (file.path === `${id.slice(0, 2)}/${id}` && copied.sha256 !== id)
        throw new Error(`素材哈希不匹配：${id}`)
      files.push({ path, ...copied })
    }
    if (spoolRefs.length) {
      const root = await lstat(join(deps.dataDir, 'job-outputs'))
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('平台输出暂存目录不安全')
    }
    for (const ref of spoolRefs) {
      const path = `job-outputs/${ref.id}`
      try {
        const copied = await copyChecked(join(deps.dataDir, path), join(part, path))
        if (copied.bytes !== ref.bytes || copied.sha256 !== ref.sha256)
          throw new Error(`平台输出暂存校验失败：${ref.id}`)
        files.push({ path, ...copied })
      } catch (error) {
        // writing 但尚未发布文件是合法的失败事实；ready 缺文件则不能产生“完整”备份。
        if (ref.state !== 'writing' || (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
      }
    }
    for (const path of CONFIGS) {
      // 配置文件被换成符号链接时同样跳过，不通过链接读出数据目录外的内容。
      if ((await lstat(join(deps.dataDir, path)).catch(() => null))?.isSymbolicLink()) {
        skippedSymlinks.push(path)
        continue
      }
      try {
        files.push({ path, ...(await copyChecked(join(deps.dataDir, path), join(part, path))) })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    for (const directory of ['plugins', 'subtitle-recognition']) {
      skippedSymlinks.push(
        ...(await symlinksIn(join(deps.dataDir, directory))).map((path) => `${directory}/${path}`),
      )
      for (const file of await filesIn(join(deps.dataDir, directory))) {
        const path = `${directory}/${file.path}`
        if (!allowedPath(path)) continue
        files.push({ path, ...(await copyChecked(join(deps.dataDir, path), join(part, path))) })
      }
    }
    const manifest: BackupManifest = {
      format: 'plein-local-backup',
      version: 1,
      id,
      createdAt: deps.now,
      containsCredentials: true,
      files,
      skippedSymlinks,
    }
    await atomicJson(join(part, 'manifest.json'), manifest)
    await rename(part, dest)
    return backupInfo(dest, manifest)
  } catch (error) {
    await rm(part, { recursive: true, force: true })
    throw error
  }
}

/**
 * 可独立调用的离线恢复入口：目标必须不存在；完整校验后原子发布新目录。
 * 不覆盖正在运行的 dataDir；服务切换目录前必须关闭。
 */
export async function restoreBackup(source: string, destination: string): Promise<void> {
  if (!(await lstat(source)).isDirectory()) throw new Error('备份目录不合法')
  const manifest = await backupManifest(source)
  try {
    await lstat(destination)
    throw new Error('恢复目标已存在，请选择新目录')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const part = `${destination}.${randomUUID()}.part`
  await mkdir(part, { recursive: true, mode: 0o700 })
  try {
    for (const file of manifest.files) {
      const path = join(source, file.path)
      // 检查每层目录，拒绝清单中的路径穿过符号链接。
      let current = source
      for (const component of file.path.split('/')) {
        current = join(current, component)
        if ((await lstat(current)).isSymbolicLink()) throw new Error('备份路径包含符号链接')
      }
      const copied = await copyChecked(path, join(part, file.path))
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256)
        throw new Error(`备份校验失败：${file.path}`)
      const assetId = /^assets\/[0-9a-f]{2}\/([0-9a-f]{64})$/.exec(file.path)?.[1]
      if (assetId && assetId !== copied.sha256) throw new Error(`素材哈希不匹配：${file.path}`)
    }
    const sqlite = new Database(join(part, 'plein.db'), { readonly: true })
    try {
      if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok')
        throw new Error('备份数据库完整性检查失败')
      const rows = sqlite.prepare('SELECT DISTINCT id FROM assets').all() as Array<{ id: string }>
      const paths = new Set(manifest.files.map((f) => f.path))
      if (rows.some((r) => !paths.has(`assets/${r.id.slice(0, 2)}/${r.id}`)))
        throw new Error('备份缺少数据库引用的素材')
      for (const ref of await storedOutputSpoolRefs(sqlite, part)) {
        const path = `job-outputs/${ref.id}`
        const file = manifest.files.find((entry) => entry.path === path)
        if (!file && ref.state === 'writing') continue
        if (!file || file.bytes !== ref.bytes || file.sha256 !== ref.sha256)
          throw new Error(`备份缺少有效的平台输出暂存：${ref.id}`)
      }
    } finally {
      sqlite.close()
    }
    await rename(part, destination)
  } catch (error) {
    await rm(part, { recursive: true, force: true })
    throw error
  }
}
