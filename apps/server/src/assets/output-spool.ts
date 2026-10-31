import { createHash, randomUUID } from 'node:crypto'
import { constants, type ReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataActivity } from '../maintenance/activity'

export interface SpoolBinding {
  ownerId: string
  jobId: string
  callKey: string
  attemptId?: string
  outputIndex: number
}

/** 宿主私有恢复引用。id 只能由宿主生成，不接受插件传入路径。 */
export interface OutputSpoolRef extends SpoolBinding {
  id: string
  sha256: string
  bytes: number
  state: 'writing' | 'ready'
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const noFollow = constants.O_NOFOLLOW ?? 0

export function isOutputSpoolRef(value: unknown): value is OutputSpoolRef {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    ID.test(v.id) &&
    typeof v.sha256 === 'string' &&
    HASH.test(v.sha256) &&
    typeof v.bytes === 'number' &&
    Number.isSafeInteger(v.bytes) &&
    v.bytes >= 0 &&
    typeof v.ownerId === 'string' &&
    !!v.ownerId &&
    typeof v.jobId === 'string' &&
    !!v.jobId &&
    typeof v.callKey === 'string' &&
    !!v.callKey &&
    (v.attemptId === undefined || typeof v.attemptId === 'string') &&
    typeof v.outputIndex === 'number' &&
    Number.isSafeInteger(v.outputIndex) &&
    v.outputIndex >= 0 &&
    (v.state === 'writing' || v.state === 'ready')
  )
}

/** 只识别命名字段里的严格引用，旧 base64/dropped 无需迁移。 */
export function outputSpoolRefs(value: unknown): OutputSpoolRef[] {
  const refs: OutputSpoolRef[] = []
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return
    if (Array.isArray(item)) {
      for (const child of item) visit(child)
      return
    }
    for (const [key, child] of Object.entries(item)) {
      if (key === 'spool' && (item as { type?: unknown }).type === 'file') {
        if (!isOutputSpoolRef(child)) throw new Error('平台输出暂存引用格式不合法')
        refs.push(child)
      } else visit(child)
    }
  }
  visit(value)
  return refs
}

/**
 * 已返回的同步字节先落到持久恢复层；不经过启动会清空的 tmp，
 * 不依赖最终 AssetStore 使用本地磁盘还是对象存储。
 */
export class OutputSpool {
  readonly root: string
  constructor(
    dataDir: string,
    private activity: DataActivity,
    private maxBytes: number,
  ) {
    this.root = join(dataDir, 'job-outputs')
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.directory()
  }

  describe(data: Uint8Array, binding: SpoolBinding): OutputSpoolRef {
    if (data.byteLength > this.maxBytes)
      throw new Error('平台输出超过本机文件上限，未暂存；不会重新提交')
    return {
      ...binding,
      id: randomUUID(),
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.byteLength,
      state: 'writing',
    }
  }

  private assert(ref: OutputSpoolRef, binding: SpoolBinding) {
    if (
      !isOutputSpoolRef(ref) ||
      ref.ownerId !== binding.ownerId ||
      ref.jobId !== binding.jobId ||
      ref.callKey !== binding.callKey ||
      ref.attemptId !== binding.attemptId ||
      ref.outputIndex !== binding.outputIndex
    )
      throw new Error('平台输出暂存引用与当前调用不匹配')
  }

  private async directory() {
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('平台输出暂存目录不安全')
  }

  private async syncDirectory() {
    const dir = await open(this.root, constants.O_RDONLY | noFollow)
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }

  async write(
    ref: OutputSpoolRef,
    data: Uint8Array,
    binding: SpoolBinding,
  ): Promise<OutputSpoolRef> {
    this.assert(ref, binding)
    if (
      data.byteLength !== ref.bytes ||
      createHash('sha256').update(data).digest('hex') !== ref.sha256
    )
      throw new Error('平台输出暂存内容与登记摘要不匹配')
    return this.activity.run(async () => {
      await this.directory()
      const part = join(this.root, `${ref.id}.part`)
      const dest = join(this.root, ref.id)
      try {
        await lstat(dest)
        throw new Error('平台输出暂存目标已存在')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const file = await open(
        part,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      )
      try {
        await file.writeFile(data)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(part, dest)
      await this.syncDirectory()
      return { ...ref, state: 'ready' }
    })
  }

  /** 以同一打开的文件校验并读流；writing 也允许核对已原子发布的最终文件。 */
  async read(ref: OutputSpoolRef, binding: SpoolBinding): Promise<ReadStream> {
    this.assert(ref, binding)
    await this.directory()
    const file = await open(join(this.root, ref.id), constants.O_RDONLY | noFollow)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== ref.bytes) throw new Error('平台输出暂存文件大小不匹配')
      const hash = createHash('sha256')
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
      if (hash.digest('hex') !== ref.sha256) throw new Error('平台输出暂存文件哈希不匹配')
      const stream = file.createReadStream({ start: 0, autoClose: false })
      // 显式持有/关闭 FileHandle；消费者可能在 ingest 前失败或提前 destroy 流。
      const close = () => {
        void file.close().catch(() => {})
      }
      stream.once('end', close)
      stream.once('close', close)
      return stream
    } catch (error) {
      await file.close()
      throw error
    }
  }

  async remove(ref: OutputSpoolRef, binding: SpoolBinding) {
    this.assert(ref, binding)
    await this.activity.run(async () => {
      await this.directory()
      for (const name of [ref.id, `${ref.id}.part`]) {
        const path = join(this.root, name)
        try {
          const stat = await lstat(path)
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('平台输出暂存清理目标不安全')
          await rm(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await this.syncDirectory()
    })
  }

  /** 只回收没有任何持久引用、且超过宽限期的孤儿。引用中的 writing/ready 永不按 TTL 删除。 */
  async prune(refs: OutputSpoolRef[], now = Date.now(), graceMs = 86_400_000) {
    await this.activity.run(async () => {
      await this.directory()
      const held = new Set(refs.map((ref) => ref.id))
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        const id = entry.name.replace(/\.part$/, '')
        if (!ID.test(id) || held.has(id)) continue
        if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('平台输出暂存清理目标不安全')
        const path = join(this.root, entry.name),
          stat = await lstat(path)
        if (now - stat.mtimeMs > graceMs) await rm(path)
      }
    })
  }
}

/** 维护/启动用的持久引用快照；已完成的 done 不再引用 spool；审计历史不构成活引用。包含独立字幕识别 journal。 */
export async function storedOutputSpoolRefs(
  db: Pick<import('better-sqlite3').Database, 'prepare'>,
  dataDir: string,
): Promise<OutputSpoolRef[]> {
  const refs: OutputSpoolRef[] = []
  const columns = (db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  )
  const wanted = ['calls'].filter((name) => columns.includes(name))
  if (wanted.length) {
    for (const row of db.prepare(`SELECT ${wanted.join(',')} FROM jobs`).iterate()) {
      for (const value of Object.values(row as Record<string, unknown>)) {
        if (typeof value !== 'string' || !value.includes('"spool"')) continue
        refs.push(...outputSpoolRefs(JSON.parse(value)))
      }
    }
  }
  const { filesIn, jsonFile } = await import('../maintenance/files')
  // 传前缀而不是拼接绝对路径，subtitle-recognition 被换成链接时不会跟随。
  for (const file of await filesIn(dataDir, 'subtitle-recognition')) {
    if (file.path.endsWith('.json')) {
      const stored = await jsonFile(join(dataDir, file.path))
      // 兼容旧版直接存 CallRecord；新版只扫描当前record，history是追溯元数据，不pin字节。
      const current =
        stored && typeof stored === 'object' && 'record' in stored
          ? (stored as { record: unknown }).record
          : stored
      refs.push(...outputSpoolRefs(current))
    }
  }
  // 多个引用里可能同时有 writing/ready；ready 引用必须优先，不能被旧 writing 放宽完整性检查。
  const found = new Map<string, OutputSpoolRef>()
  for (const ref of refs) {
    const previous = found.get(ref.id)
    if (
      previous &&
      (previous.sha256 !== ref.sha256 ||
        previous.bytes !== ref.bytes ||
        previous.ownerId !== ref.ownerId ||
        previous.jobId !== ref.jobId ||
        previous.callKey !== ref.callKey ||
        previous.attemptId !== ref.attemptId ||
        previous.outputIndex !== ref.outputIndex)
    )
      throw new Error('同一平台输出暂存 ID 存在互相冲突的绑定')
    if (!previous || ref.state === 'ready') found.set(ref.id, ref)
  }
  return [...found.values()]
}
