import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 字幕字体：导出烧字幕（libass）和预览（JASSUB，同样是 libass）用同一个字体文件，
 * 两边的字形、字宽、换行才一致。
 *
 * 查找顺序：PLEIN_SUBTITLE_FONT（桌面安装包附带的 Noto Sans CJK SC）→ fontconfig 里的
 * Noto Sans CJK SC（Docker 镜像、CI）→ macOS 系统自带的中文字体。都没有时返回 null，
 * 导出按原来的字体名交给 libass 自己兜底，预览退回近似的 DOM 字幕。
 */
export interface SubtitleFont {
  file: string
  /** 写进 ASS 样式的字体族名（取自字体文件的 name 表，libass 按它匹配） */
  family: string
  size: number
  mtime: number
}

const MAC_FALLBACKS = [
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
]

let configured: string | undefined
let cache: Promise<SubtitleFont | null> | null = null

export function setSubtitleFont(file: string | undefined) {
  configured = file
  cache = null
}

export function subtitleFont(): Promise<SubtitleFont | null> {
  cache ??= findFont().catch((err) => {
    console.warn('[fonts] 找字幕字体失败：', (err as Error).message)
    return null
  })
  return cache
}

async function findFont(): Promise<SubtitleFont | null> {
  const candidates: string[] = []
  if (configured) candidates.push(configured)
  const fc = await run('fc-match', ['-f', '%{file}', 'Noto Sans CJK SC:style=Regular']).then(
    ({ stdout }) => stdout.trim(),
    () => '',
  )
  if (/noto.*cjk/i.test(fc)) candidates.push(fc)
  if (process.platform === 'darwin') candidates.push(...MAC_FALLBACKS)
  for (const file of candidates) {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) continue
    const families = await fontFamilies(file).catch(() => [])
    // 多语言合集（NotoSansCJK.ttc）里优先简体中文那一款
    const family = families.find((f) => /\bSC\b/.test(f)) ?? families[0]
    if (family) return { file, family, size: info.size, mtime: info.mtimeMs }
  }
  return null
}

/**
 * 读字体文件 name 表里的字体族名（OTF / TTF / TTC，合集里每个字型各一个）。
 * 优先“首选族名”（nameID 16），没有再用 nameID 1；取 Windows 平台的英文名。
 * 只读文件头和 name 表，不把十几 MB 的字体整个读进来。
 */
export async function fontFamilies(file: string): Promise<string[]> {
  const fh = await open(file, 'r')
  const read = async (offset: number, length: number) => {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    if (bytesRead < length) throw new Error('字体文件不完整')
    return buf
  }
  try {
    const head = await read(0, 12)
    let faces = [0]
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const count = head.readUInt32BE(8)
      const offsets = await read(12, count * 4)
      faces = Array.from({ length: count }, (_, i) => offsets.readUInt32BE(i * 4))
    }
    const names: string[] = []
    for (const face of faces) {
      const dir = await read(face, 12)
      const tables = dir.readUInt16BE(4)
      const records = await read(face + 12, tables * 16)
      let name: { offset: number; length: number } | undefined
      for (let i = 0; i < tables; i++) {
        if (records.toString('latin1', i * 16, i * 16 + 4) === 'name')
          name = {
            offset: records.readUInt32BE(i * 16 + 8),
            length: records.readUInt32BE(i * 16 + 12),
          }
      }
      if (!name) continue
      const table = await read(name.offset, name.length)
      const family = familyName(table)
      if (family && !names.includes(family)) names.push(family)
    }
    return names
  } finally {
    await fh.close()
  }
}

function familyName(table: Buffer): string | undefined {
  const count = table.readUInt16BE(2)
  const strings = table.readUInt16BE(4)
  const found = new Map<number, string>()
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12
    const platform = table.readUInt16BE(r)
    const language = table.readUInt16BE(r + 4)
    const id = table.readUInt16BE(r + 6)
    if ((id !== 1 && id !== 16) || found.has(id)) continue
    // Windows 平台 Unicode（UTF-16BE），英文（0x409）
    if (platform !== 3 || language !== 0x409) continue
    const length = table.readUInt16BE(r + 8)
    const offset = strings + table.readUInt16BE(r + 10)
    const raw = table.subarray(offset, offset + length)
    let text = ''
    for (let k = 0; k + 1 < raw.length; k += 2) text += String.fromCharCode(raw.readUInt16BE(k))
    found.set(id, text)
  }
  return found.get(16) ?? found.get(1)
}
