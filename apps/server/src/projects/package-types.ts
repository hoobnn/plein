import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import type { NodeRun } from '@plein/doc'
import type { ProjectImportErrorCode } from '@plein/protocol'
import type { AssetStore } from '../assets/store'
import type { MediaIndex } from '../media-index/service'
import type { PluginHost } from '../plugins/host'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'

/**
 * 项目包（导出 / 导入）共用的类型、错误与常量。
 * 格式见 @plein/protocol 的 project-package.ts。
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
export const MANIFEST = 'manifest.json'
export const HISTORY = 'history/jobs.json'
/** 清单本身的体积上限 */
export const MANIFEST_LIMIT = 64 * 1024 * 1024
export const ASSET_ID = /^[0-9a-f]{64}$/
export const RUNNING_NOTE = '导出时仍在运行；迁入后不会自动续查或重新提交'

export class PackageError extends Error {
  constructor(
    readonly code: ProjectImportErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class PackageTooLargeError extends Error {}

export const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** 运行中 / 排队的状态改成已取消的历史记录，不留下进度和阶段 */
export function settledRun(run: NodeRun, note: string): NodeRun {
  if (run.status !== 'queued' && run.status !== 'running') return run
  return { id: run.id, status: 'canceled', error: note, at: Date.now() }
}

/** 把错误信息、运行状态里的本机路径换成省略号：数据目录和用户主目录 */
export function pathScrubber(dataDir: string) {
  const roots = [dataDir, homedir()].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)
  return (text: string) => roots.reduce((t, r) => t.split(r).join('…'), text)
}
