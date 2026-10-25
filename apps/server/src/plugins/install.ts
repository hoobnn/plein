import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import { PLUGIN_API_VERSION, PluginManifest, parseNodeKey, vendorOf } from '@plein/plugin-sdk'
import { PLUGIN_INSTALL_MAX_UPLOAD, type PluginInstallPreview } from '@plein/protocol'
import semver from 'semver'
import { openZipEntry, type ZipEntry } from '../projects/zip'
import type { ExternalPlugins } from './external'

const TTL = 10 * 60_000
const MAX_FILES = 500
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MANIFEST = 'plein-plugin.json'

export class PluginInstallError extends Error {
  constructor(
    readonly code: 'invalid' | 'conflict' | 'expired' | 'disabled',
    message: string,
  ) {
    super(message)
  }
}
function invalid(message: string): never {
  throw new PluginInstallError('invalid', message)
}
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** 安装包只接受普通文件与目录；跨平台路径必须唯一。 */
function safePath(name: string) {
  return (
    !!name &&
    !name.startsWith('/') &&
    // oxlint-disable-next-line no-control-regex
    !/[\\:"<>|?*\u0000-\u001f\u007f]/.test(name) &&
    name
      .replace(/\/$/, '')
      .split('/')
      .every(
        (s) =>
          !!s &&
          s !== '.' &&
          s !== '..' &&
          !/[ .]$/.test(s) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
      )
  )
}

interface Entry extends ZipEntry {
  crc: number
  directory: boolean
  relative: string
}

function checkExtra(data: Buffer, at: number, length: number) {
  const end = at + length
  while (at < end) {
    if (at + 4 > end) invalid('ZIP 扩展字段损坏')
    const kind = data.readUInt16LE(at)
    const size = data.readUInt16LE(at + 2)
    if (kind === 1) invalid('不支持 ZIP64')
    at += 4 + size
    if (at > end) invalid('ZIP 扩展字段越界')
  }
}

/** 单独校验中央目录的外部属性，避免把符号链接或特殊文件当作 JS 文件安装。 */
function indexZip(data: Buffer): Entry[] {
  if (data.length < 22 || data.length > PLUGIN_INSTALL_MAX_UPLOAD)
    invalid('插件 ZIP 大小不合法（上限 20 MiB）')
  let end = -1
  for (let p = data.length - 22; p >= Math.max(0, data.length - 22 - 65535); p--)
    if (data.readUInt32LE(p) === 0x06054b50 && p + 22 + data.readUInt16LE(p + 20) === data.length) {
      end = p
      break
    }
  if (end < 0) invalid('ZIP 结尾目录缺失或损坏')
  const count = data.readUInt16LE(end + 10)
  const size = data.readUInt32LE(end + 12)
  const offset = data.readUInt32LE(end + 16)
  if (
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    data.readUInt16LE(end + 8) !== count
  )
    invalid('不支持分卷 ZIP')
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) invalid('不支持 ZIP64')
  if (!count || count > MAX_FILES || offset + size !== end) invalid('ZIP 文件数或目录范围不合法')
  const entries: Entry[] = []
  const names = new Set<string>()
  const spellings = new Map<string, string>()
  const spans: Array<[number, number]> = []
  let total = 0
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || data.readUInt32LE(p) !== 0x02014b50) invalid('ZIP 目录损坏')
    const flags = data.readUInt16LE(p + 8)
    const method = data.readUInt16LE(p + 10)
    const nameLen = data.readUInt16LE(p + 28)
    const extraLen = data.readUInt16LE(p + 30)
    const commentLen = data.readUInt16LE(p + 32)
    const next = p + 46 + nameLen + extraLen + commentLen
    if (next > end || flags & ~0x080e || data.readUInt16LE(p + 34)) invalid('不支持加密或分卷 ZIP')
    if (method !== 0 && method !== 8) invalid('仅支持存储或 deflate 压缩的 ZIP')
    const rawName = data.subarray(p + 46, p + 46 + nameLen)
    checkExtra(data, p + 46 + nameLen, extraLen)
    const name = rawName.toString('utf8')
    if (!Buffer.from(name).equals(rawName) || !safePath(name)) invalid('ZIP 包含不安全路径')
    const unixMode = data.readUInt32LE(p + 38) >>> 16
    const kind = unixMode & 0xf000
    const directory = name.endsWith('/')
    if (kind && kind !== 0x8000 && kind !== 0x4000) invalid('ZIP 不允许符号链接或特殊文件')
    if ((kind === 0x4000 && !directory) || (kind === 0x8000 && directory))
      invalid('ZIP 文件类型与路径不一致')
    const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase()
    if (names.has(key)) invalid('ZIP 包含重复或大小写冲突路径')
    names.add(key)
    const segments = name.replace(/\/$/, '').split('/')
    for (let n = 1; n <= segments.length; n++) {
      const spelling = segments.slice(0, n).join('/')
      const folded = spelling.normalize('NFC').toLowerCase()
      const before = spellings.get(folded)
      if (before !== undefined && before !== spelling) invalid('ZIP 包含大小写或 Unicode 冲突路径')
      spellings.set(folded, spelling)
    }
    const compressedSize = data.readUInt32LE(p + 20)
    const bytes = data.readUInt32LE(p + 24)
    const local = data.readUInt32LE(p + 42)
    if (compressedSize === 0xffffffff || bytes === 0xffffffff || local === 0xffffffff)
      invalid('不支持 ZIP64')
    if (bytes > MAX_FILE_BYTES || (total += bytes) > MAX_TOTAL_BYTES || (directory && bytes))
      invalid('ZIP 解压体积超过限制')
    if (bytes > Math.max(1, compressedSize) * 200) invalid('ZIP 压缩比超过限制')
    if (local + 30 > offset || data.readUInt32LE(local) !== 0x04034b50)
      invalid('ZIP 本地文件头损坏')
    const localNameLen = data.readUInt16LE(local + 26)
    const start = local + 30 + localNameLen + data.readUInt16LE(local + 28)
    if (
      start + compressedSize > offset ||
      data.readUInt16LE(local + 6) !== flags ||
      data.readUInt16LE(local + 8) !== method ||
      !data.subarray(local + 30, local + 30 + localNameLen).equals(rawName)
    )
      invalid('ZIP 本地文件头与目录不一致')
    checkExtra(data, local + 30 + localNameLen, data.readUInt16LE(local + 28))
    const crc = data.readUInt32LE(p + 16)
    if (
      !(flags & 8) &&
      (data.readUInt32LE(local + 14) !== crc ||
        data.readUInt32LE(local + 18) !== compressedSize ||
        data.readUInt32LE(local + 22) !== bytes)
    )
      invalid('ZIP 文件长度或校验信息不一致')
    spans.push([local, start + compressedSize])
    entries.push({
      name,
      method,
      compressedSize,
      size: bytes,
      offset: local,
      crc,
      directory,
      relative: name,
    })
    p = next
  }
  if (p !== end) invalid('ZIP 目录长度不一致')
  spans.sort((a, b) => a[0] - b[0])
  if (spans.some((s, i) => i > 0 && s[0] < spans[i - 1]![1])) invalid('ZIP 文件条目重叠')
  for (const e of entries) {
    const parts = e.name.replace(/\/$/, '').split('/')
    for (let n = 1; n < parts.length; n++) {
      const parent = parts.slice(0, n).join('/').normalize('NFC').toLowerCase()
      if (
        entries.some(
          (other) => !other.directory && other.name.normalize('NFC').toLowerCase() === parent,
        )
      )
        invalid('ZIP 文件与目录路径冲突')
    }
  }
  const manifests = entries.filter(
    (e) => !e.directory && (e.name === MANIFEST || e.name.endsWith(`/${MANIFEST}`)),
  )
  if (manifests.length !== 1) invalid('ZIP 必须包含唯一的 plein-plugin.json')
  const manifest = manifests[0]!
  const prefix = manifest.name.slice(0, -MANIFEST.length)
  if (prefix && prefix.slice(0, -1).includes('/'))
    invalid('清单必须位于 ZIP 根目录或唯一的一层文件夹中')
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) invalid('ZIP 包含插件目录之外的文件')
    e.relative = e.name.slice(prefix.length)
  }
  return entries
}

async function consume(zip: string, entry: Entry, destination?: string): Promise<Buffer | null> {
  let bytes = 0
  let crc = 0
  const chunks: Buffer[] = []
  const check = new Transform({
    transform(chunk: Buffer, _encoding, cb) {
      bytes += chunk.length
      if (bytes > entry.size || bytes > MAX_FILE_BYTES)
        return cb(new Error('ZIP 实际解压体积超过限制'))
      crc = crc32(chunk, crc)
      if (entry.relative === MANIFEST) {
        if (bytes > 64 * 1024) return cb(new Error('插件清单超过 64 KiB'))
        chunks.push(chunk)
      }
      cb(null, chunk)
    },
  })
  const source = await openZipEntry(zip, entry)
  if (destination) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await pipeline(source, check, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  } else
    await pipeline(
      source,
      check,
      new Transform({
        transform(_chunk, _encoding, cb) {
          cb()
        },
      }),
    )
  if (bytes !== entry.size || crc !== entry.crc) invalid('ZIP 文件大小或 CRC 校验失败')
  return entry.relative === MANIFEST ? Buffer.concat(chunks) : null
}

function checkManifest(raw: Buffer, entries: Entry[]) {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    invalid('插件清单不是合法 JSON')
  }
  const parsed = PluginManifest.safeParse(value)
  if (!parsed.success) invalid(`插件清单不合法：${parsed.error.issues[0]?.message ?? ''}`)
  const m = parsed.data
  if (
    !semver.validRange(m.engines.plein) ||
    !semver.satisfies(PLUGIN_API_VERSION, m.engines.plein, { includePrerelease: true })
  )
    invalid(`插件需要 API ${m.engines.plein}，当前为 ${PLUGIN_API_VERSION}`)
  if (
    !m.main?.server ||
    !safePath(m.main.server) ||
    m.main.server.endsWith('/') ||
    !entries.some((e) => !e.directory && e.relative === m.main?.server)
  )
    invalid('找不到合法的 main.server 入口文件')
  if (m.contributes.elements.length || m.contributes.capabilities.length)
    invalid('本机第三方插件暂不支持自定义元素或能力')
  for (const [kind, ids] of Object.entries(m.contributes)) {
    if (new Set(ids).size !== ids.length) invalid(`贡献 ${kind} 含重复项`)
    for (const id of ids) {
      const node = kind === 'nodes' ? parseNodeKey(id) : null
      if ((kind === 'nodes' && !node) || vendorOf(node?.type ?? id) !== vendorOf(m.id))
        invalid('贡献项必须在插件自己的命名空间内')
    }
  }
  return m
}

interface Pending {
  owner: string
  dir: string
  zip: string
  entries: Entry[]
  preview: PluginInstallPreview
}

export class PluginInstaller {
  private pending = new Map<string, Pending>()
  private serial: Promise<unknown> = Promise.resolve()
  private closed = false
  private timer: ReturnType<typeof setInterval>
  constructor(
    private dataDir: string,
    private ext: ExternalPlugins,
    private reserved: (id: string) => boolean,
    private now = Date.now,
  ) {
    this.timer = setInterval(() => {
      void this.exclusive(() => this.expire()).catch(() => {})
    }, 60_000)
    this.timer.unref()
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.serial.then(run, run)
    this.serial = result.catch(() => {})
    return result
  }
  private async roots() {
    const base = await realpath(this.dataDir)
    const root = join(base, 'plugins')
    const staging = join(base, 'plugin-installs')
    for (const path of [root, staging]) {
      await mkdir(path, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
      const s = await lstat(path)
      if (!s.isDirectory() || s.isSymbolicLink() || (await realpath(path)) !== path)
        invalid('插件目录不能是符号链接')
    }
    return { root, staging }
  }
  private async expire() {
    for (const [token, item] of this.pending)
      if (item.preview.expiresAt <= this.now()) {
        this.pending.delete(token)
        await rm(item.dir, { recursive: true, force: true })
      }
  }
  private available(id: string) {
    this.ext.scan()
    if (this.reserved(id) || this.ext.list().some((p) => p.id === id))
      throw new PluginInstallError('conflict', '插件 ID 已存在，不支持覆盖安装；请保留当前版本')
  }
  preview(data: Uint8Array, owner: string): Promise<PluginInstallPreview> {
    return this.exclusive(async () => {
      if (this.closed) throw new PluginInstallError('disabled', '插件安装服务已关闭')
      await this.expire()
      for (const [token, item] of this.pending)
        if (item.owner === owner) {
          this.pending.delete(token)
          await rm(item.dir, { recursive: true, force: true })
        }
      if (this.pending.size >= 8)
        throw new PluginInstallError('conflict', '待确认插件包过多，请稍后重试')
      const bytes = Buffer.from(data)
      const entries = indexZip(bytes)
      const { staging } = await this.roots()
      const dir = await mkdtemp(join(staging, 'preview-'))
      const zip = join(dir, 'package.zip')
      try {
        await writeFile(zip, bytes, { flag: 'wx', mode: 0o600 })
        let raw: Buffer | null = null
        for (const e of entries) if (!e.directory) raw = (await consume(zip, e)) ?? raw
        if (!raw) invalid('缺少插件清单')
        const manifest = checkManifest(raw, entries)
        this.available(manifest.id)
        const preview: PluginInstallPreview = {
          token: randomUUID(),
          expiresAt: this.now() + TTL,
          sha256: sha(bytes),
          files: entries.filter((e) => !e.directory).length,
          bytes: entries.reduce((n, e) => n + e.size, 0),
          manifest,
        }
        this.pending.set(preview.token, { owner, dir, zip, entries, preview })
        return preview
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        if (error instanceof PluginInstallError) throw error
        throw new PluginInstallError('invalid', `插件包预检失败：${(error as Error).message}`)
      }
    })
  }
  cancel(token: string, owner: string) {
    return this.exclusive(async () => {
      const item = this.pending.get(token)
      if (!item || item.owner !== owner) return
      this.pending.delete(token)
      await rm(item.dir, { recursive: true, force: true })
    })
  }
  install(token: string, owner: string) {
    return this.exclusive(async () => {
      const item = this.pending.get(token)
      if (!item || item.owner !== owner)
        throw new PluginInstallError('expired', '预检已过期，请重新选择插件包')
      this.pending.delete(token) // 每次确认最多执行一次，失败也必须重新预检。
      let target: string | undefined
      let claimed = false
      try {
        if (this.closed || item.preview.expiresAt <= this.now())
          throw new PluginInstallError('expired', '预检已过期，请重新选择插件包')
        const { root } = await this.roots()
        if (sha(await readFile(item.zip)) !== item.preview.sha256) invalid('插件包在预检后发生变化')
        this.available(item.preview.manifest.id)
        const unpacked = join(item.dir, 'unpacked')
        await mkdir(unpacked, { mode: 0o700 })
        for (const e of item.entries)
          if (!e.directory) await consume(item.zip, e, join(unpacked, e.relative))
        // mkdir 是 no-replace 占位：已有目录（包括空目录）或符号链接均失败。
        // 扫描器看不到占位目录中的清单，完整包只在 rename 后才出现。
        target = join(root, `plugin-${sha(Buffer.from(item.preview.manifest.id))}`)
        await mkdir(target, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'EEXIST')
            throw new PluginInstallError('conflict', '插件安装目录已存在，不会覆盖')
          throw e
        })
        claimed = true
        this.ext.prepareInstall(item.preview.manifest.id)
        await rename(unpacked, target)
        this.ext.scan()
        const info = this.ext.list().find((p) => p.id === item.preview.manifest.id)
        if (!info) throw new Error('安装后未找到插件')
        target = undefined
        return info
      } finally {
        if (target && claimed) {
          // 发布前只留下本轮创建的空占位；发布后若状态登记失败则移回暂存再清理。
          await rmdir(target).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOTEMPTY') return
            await rename(target!, join(item.dir, 'rollback')).catch(() => {})
          })
          this.ext.scan()
        }
        await rm(item.dir, { recursive: true, force: true })
      }
    })
  }
  async close() {
    this.closed = true
    clearInterval(this.timer)
    await this.exclusive(async () => {
      for (const item of this.pending.values()) await rm(item.dir, { recursive: true, force: true })
      this.pending.clear()
    })
  }
}
