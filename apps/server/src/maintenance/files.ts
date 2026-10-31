import { createHash } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const part = `${path}.part`
  await writeFile(part, JSON.stringify(value, null, 2), { mode: 0o600 })
  await chmod(part, 0o600)
  await rename(part, path)
}

export async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

interface WalkOptions {
  /** false 时只收集路径，不逐个 lstat 统计文件大小。 */
  stats: boolean
  /** 相对 root 的目录名；整个子树不扫描，也不算跳过项。 */
  skip: Set<string>
}

export interface WalkResult {
  /** 相对 root 的普通文件路径；符号链接不在其中。 */
  files: Array<{ path: string; bytes: number; mtime: number }>
  /** 符号链接路径（相对 root）；只记录，不跟随、不读取、不删除。 */
  symlinks: string[]
  /** 因权限不足而跳过的目录（相对 root）。 */
  unreadableDirs: string[]
}

/**
 * 递归遍历扫描根 join(root, prefix)。符号链接一律不跟随、不读取、不删除：
 * 文件统计里跳过，路径单独收集给调用方上报，维护因此不会越出数据目录。
 * prefix 非空时先用 lstat 检查扫描根本身（如整个 assets 目录被换成链接），
 * 所以扫描子目录请传前缀而不是拼接好的绝对路径；prefix 为空时 root 就是
 * 用户选定的数据目录锚点，可能本身是系统级链接（如 macOS /var），照常跟随。
 */
async function walk(
  root: string,
  prefix: string,
  options: WalkOptions,
  /** 递归进入的子目录已由父级 readdir 确认类型，不再重复 lstat 前缀。 */
  typed = false,
): Promise<WalkResult> {
  const empty = (): WalkResult => ({ files: [], symlinks: [], unreadableDirs: [] })
  // 扫描根本身若是符号链接（如整个 assets 目录被替换），同样不进入。
  if (prefix && !typed) {
    if (options.skip.has(prefix)) return empty()
    const stat = await lstat(join(root, prefix)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return empty()
    if (stat.isSymbolicLink()) return { files: [], symlinks: [prefix], unreadableDirs: [] }
  }
  const files: Array<{ path: string; bytes: number; mtime: number }> = []
  const symlinks: string[] = []
  const unreadableDirs: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 目录消失或不可读都不让整体失败：前者当空目录，后者跳过并上报。
    if (code === 'ENOENT') return empty()
    if ((code === 'EACCES' || code === 'EPERM') && prefix)
      return { files: [], symlinks: [], unreadableDirs: [prefix] }
    throw error
  }
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (options.skip.has(path)) continue
    if (entry.isSymbolicLink()) symlinks.push(path)
    else if (entry.isDirectory()) {
      const nested = await walk(root, path, options, true)
      files.push(...nested.files)
      symlinks.push(...nested.symlinks)
      unreadableDirs.push(...nested.unreadableDirs)
    } else if (entry.isFile() && options.stats) {
      const stat = await lstat(join(root, path))
      files.push({ path, bytes: stat.size, mtime: stat.mtimeMs })
    }
  }
  return { files, symlinks, unreadableDirs }
}

export interface FileScan {
  files: Array<{ path: string; bytes: number; mtime: number }>
  /** 因权限不足而跳过的目录（相对 root）；完整性敏感的调用方必须检查。 */
  unreadableDirs: string[]
}

/** 列出 root/prefix 下的普通文件；符号链接不跟随也不统计，避免越出数据目录。 */
export async function filesIn(root: string, prefix = ''): Promise<FileScan> {
  const { files, unreadableDirs } = await walk(root, prefix, { stats: true, skip: new Set() })
  return { files, unreadableDirs }
}

/** 收集 root/prefix 下的符号链接路径（相对 root）；只记录，不跟随、不读取、不删除。 */
export async function symlinksIn(
  root: string,
  prefix = '',
  skip: string[] = [],
): Promise<string[]> {
  return (await walk(root, prefix, { stats: false, skip: new Set(skip) })).symlinks
}

/** 全量收集符号链接与不可读目录（相对 root），供维护状态上报；不统计文件大小。 */
export async function scanTree(
  root: string,
  prefix = '',
  skip: string[] = [],
): Promise<WalkResult> {
  return walk(root, prefix, { stats: false, skip: new Set(skip) })
}

/**
 * 实际移动、恢复、删除前的逐层检查：从 dataDir 起相对路径的每一级（含末项）
 * 都不能是符号链接，否则抛错。扫描阶段的检查只是快照，目录可能在操作前被
 * 换成链接；不存在的层级停止检查（恢复目标本来就尚未建立）。
 */
export async function assertInsideDataDir(dataDir: string, rel: string) {
  let current = dataDir
  for (const part of rel.split('/')) {
    current = join(current, part)
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error(`路径包含符号链接，已停止操作：${rel}`)
  }
}

export async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function safeRelative(path: string) {
  return (
    !!path &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '..' || part === '.' || !part) &&
    posix.normalize(path) === path &&
    !path.includes(':')
  )
}

export async function copyChecked(source: string, destination: string) {
  const stat = await lstat(source)
  if (!stat.isFile()) throw new Error('备份源文件不是普通文件')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(source, destination)
  await chmod(destination, stat.mode & 0o111 ? 0o700 : 0o600)
  return { bytes: (await lstat(destination)).size, sha256: await hashFile(destination) }
}
