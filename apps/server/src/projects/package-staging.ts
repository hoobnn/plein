import { rm } from 'node:fs/promises'
import type { PackageJob, ProjectPackageManifest } from '@plein/protocol'
import type { CheckpointArchive } from '../checkpoints/archive'

/**
 * 导入暂存区：预检通过的包先放在这里，用户确认前不写数据库。
 * 暂存内容只在本进程内，进程重启即失效。
 */

/** 预检后多久不确认就放弃暂存 */
export const PENDING_TTL = 30 * 60_000

export interface Pending {
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

export async function dropPending(token: string) {
  const p = pending.get(token)
  if (!p) return
  pending.delete(token)
  await rm(p.dir, { recursive: true, force: true })
}

/** 清掉过期未确认的暂存 */
export async function sweep() {
  const now = Date.now()
  for (const [token, p] of pending) if (p.expires < now) await dropPending(token)
}

/** 登记一次预检通过的包 */
export function stagePending(token: string, p: Pending) {
  pending.set(token, p)
}

/** 取一次预检通过的包（不删除） */
export function getPending(token: string): Pending | undefined {
  return pending.get(token)
}

/** 取走一次预检通过的包（确认导入时用，令牌只能确认一次） */
export function takePending(token: string): Pending | undefined {
  const p = pending.get(token)
  if (p) pending.delete(token)
  return p
}
