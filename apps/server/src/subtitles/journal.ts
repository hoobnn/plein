import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { SubmissionAudit } from '@plein/protocol'
import type { CallRecord } from '../plugins/host'

export interface StoredRecognition {
  assetId: string
  model: string
  record?: CallRecord | null
  migratedFrom?: string
  history?: Array<{ record: CallRecord; at: number; action: string }>
  audit?: SubmissionAudit[]
  confirmedReset?: boolean
}

export function readRecord(file: string): StoredRecognition | undefined {
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredRecognition & CallRecord
    return 'record' in stored ? stored : { assetId: '', model: '', record: stored }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

/** 同一文件保存当前调用、关联信息和审计；完整写入并fsync后原子替换。 */
export function writeRecord(file: string, value: StoredRecognition) {
  const tmp = `${file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
  }
}
