import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'

/**
 * 按中央目录读 zip：只取条目位置，内容按需流式读出，不把整个包读进内存。
 * 只支持项目包会用到的部分：存储（0）与 deflate（8），不支持 zip64、加密和分卷。
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  /** 本地文件头的位置 */
  offset: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
/** 中央目录结尾记录 22 字节，后面最多跟 65535 字节注释 */
const EOCD_SEARCH = 22 + 0xffff

export async function readZipIndex(file: string): Promise<ZipEntry[]> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    if (size < 22) throw new ZipError('文件太小，不是 zip')
    const tailLen = Math.min(size, EOCD_SEARCH)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let at = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        at = i
        break
      }
    }
    if (at < 0) throw new ZipError('找不到 zip 目录')
    const count = tail.readUInt16LE(at + 10)
    const cdSize = tail.readUInt32LE(at + 12)
    const cdOffset = tail.readUInt32LE(at + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw new ZipError('不支持 zip64')
    if (cdOffset + cdSize > size) throw new ZipError('zip 目录越界')
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const entries: ZipEntry[] = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new ZipError('zip 目录损坏')
      const flags = cd.readUInt16LE(p + 8)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      if (flags & 1) throw new ZipError('不支持加密的 zip')
      const entry: ZipEntry = {
        method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
        name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen),
      }
      if (entry.offset + entry.compressedSize > size) throw new ZipError('zip 条目越界')
      entries.push(entry)
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    await fh.close()
  }
}

/** 条目内容的流（已解压）；调用方负责限制和校验读出的字节数 */
export async function openZipEntry(file: string, entry: ZipEntry): Promise<Readable> {
  if (entry.method !== 0 && entry.method !== 8)
    throw new ZipError(`不支持的压缩方式 ${entry.method}`)
  const fh = await open(file, 'r')
  let start: number
  try {
    const head = Buffer.alloc(30)
    await fh.read(head, 0, 30, entry.offset)
    if (head.readUInt32LE(0) !== LOCAL) throw new ZipError('zip 条目头损坏')
    start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  } finally {
    await fh.close()
  }
  const raw =
    entry.compressedSize === 0
      ? Readable.from([])
      : createReadStream(file, { start, end: start + entry.compressedSize - 1 })
  if (entry.method === 0) return raw
  const inflate = createInflateRaw()
  raw.on('error', (err) => inflate.destroy(err))
  return raw.pipe(inflate)
}

/** 条目名是否安全：相对路径、没有 .. 段、没有反斜杠和控制字符 */
export function safeEntryName(name: string) {
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  // oxlint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f]/.test(name)) return false
  return name.split('/').every((seg) => seg !== '..' && seg !== '.')
}
