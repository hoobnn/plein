import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CONFIGS } from './backup'

/**
 * 应用内恢复：运行中的 SQLite 不能被替换，所以先把校验过的完整副本放在
 * maintenance/restored/<id>，登记「待恢复」，下次启动在打开数据库之前换进数据目录。
 */
const Pending = z.object({
  version: z.literal(1),
  /** 相对 maintenance 目录的暂存副本 */
  stage: z.string().regex(/^restored\/[0-9a-f-]{36}$/),
  /** 暂存副本里需要换进数据目录的条目，登记时一次定下，换到一半重跑也以它为准 */
  names: z.array(z.string()).min(1),
  backupId: z.string().uuid(),
  backupCreatedAt: z.number(),
  /** 恢复前自动生成的当前数据备份 */
  preRestoreBackupId: z.string().uuid(),
  requestedAt: z.number(),
})
export type PendingRestore = z.infer<typeof Pending>

/** 恢复会整体替换的数据条目；其余（maintenance 等）保持原样 */
const MANAGED = [
  'plein.db',
  'plein.db-wal',
  'plein.db-shm',
  'assets',
  'job-outputs',
  'plugins',
  'subtitle-recognition',
  ...CONFIGS,
]

const pendingFile = (dataDir: string) => join(dataDir, 'maintenance', 'pending-restore.json')

export async function readPendingRestore(dataDir: string): Promise<PendingRestore | null> {
  try {
    return Pending.parse(JSON.parse(await readFile(pendingFile(dataDir), 'utf8')))
  } catch {
    return null
  }
}

/** 登记待恢复。names 取暂存副本里属于数据条目的部分，必须含数据库。 */
export async function writePendingRestore(
  dataDir: string,
  pending: Omit<PendingRestore, 'version' | 'names'>,
) {
  const names = (await readdir(join(dataDir, 'maintenance', pending.stage))).filter((name) =>
    MANAGED.includes(name),
  )
  if (!names.includes('plein.db')) throw new Error('恢复副本缺少数据库')
  const file = pendingFile(dataDir)
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, names, ...pending }), { mode: 0o600 })
  await rename(tmp, file)
}

/** 取消待恢复：删掉登记和暂存副本；没有登记时什么也不做 */
export async function clearPendingRestore(dataDir: string) {
  const pending = await readPendingRestore(dataDir)
  await rm(pendingFile(dataDir), { force: true })
  if (pending)
    await rm(join(dataDir, 'maintenance', pending.stage), { recursive: true, force: true })
}

/**
 * 启动时在打开数据库之前调用。逐项把旧数据挪进 maintenance/replaced/<时间>，
 * 再把暂存副本里的同名条目换进来；备份里没有的条目也让位，恢复后与备份一致。
 * 每项先移走旧的再放新的，且只对尚在暂存目录里的条目动手，所以中途失败重跑是安全的。
 * 登记损坏或暂存副本不见了就丢弃登记，按当前数据正常启动。返回是否做了替换。
 */
export async function applyPendingRestore(
  dataDir: string,
  log: (message: string) => void = console.log,
): Promise<boolean> {
  const file = pendingFile(dataDir)
  const pending = await readPendingRestore(dataDir)
  if (!pending) {
    await rm(file, { force: true })
    return false
  }
  const stage = join(dataDir, 'maintenance', pending.stage)
  const inStage = new Set(await readdir(stage).catch(() => [] as string[]))
  if (!pending.names.some((name) => inStage.has(name))) {
    log('待恢复的暂存副本不存在，已忽略恢复请求')
    await rm(file, { force: true })
    return false
  }
  const replaced = join(dataDir, 'maintenance', 'replaced', String(pending.requestedAt))
  await mkdir(replaced, { recursive: true, mode: 0o700 })
  const present = new Set(await readdir(dataDir))
  for (const name of MANAGED) {
    const restoring = pending.names.includes(name)
    // 已经换进去的条目不在暂存目录里了，不能再当旧数据挪走
    if (restoring && !inStage.has(name)) continue
    if (present.has(name)) await rename(join(dataDir, name), join(replaced, name))
    if (restoring) await rename(join(stage, name), join(dataDir, name))
  }
  await rm(stage, { recursive: true, force: true })
  await rm(file, { force: true })
  log(`已从备份 ${pending.backupId} 恢复数据，原数据保留在 ${replaced}`)
  return true
}
