import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
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

/**
 * 递归遍历扫描根 join(root, prefix)。符号链接一律不跟随、不读取、不删除：
 * 文件统计里跳过，路径单独收集给调用方上报，维护因此不会越出数据目录。
 * prefix 非空时先用 lstat 检查扫描根本身（如整个 assets 目录被换成链接）
 * ，所以扫描子目录请传前缀而不是拼接好的绝对路径；prefix 为空时 root
 * 就是用户选定的数据目录锄点，可能本身是系统级链接（如 macOS /var），照常跟随。
 */
async function walk(
  root: string,
  prefix: string,
  options: WalkOptions,
): Promise<{ files: Array<{ path: string; bytes: number; mtime: number }>; symlinks: string[] }> {
  // 扫描根本身若是符号链接（如整个 assets 目录被替换），同样不进入。
  if (prefix) {
    if (options.skip.has(prefix)) return { files: [], symlinks: [] }
    const stat = await lstat(join(root, prefix)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return { files: [], symlinks: [] }
    if (stat.isSymbolicLink()) return { files: [], symlinks: [prefix] }
  }
  const files: Array<{ path: string; bytes: number; mtime: number }> = []
  const symlinks: string[] = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (options.skip.has(path)) continue
    if (entry.isSymbolicLink()) symlinks.push(path)
    else if (entry.isDirectory()) {
      const nested = await walk(root, path, options)
      files.push(...nested.files)
      symlinks.push(...nested.symlinks)
    } else if (entry.isFile() && options.stats) {
      const stat = await lstat(join(root, path))
      files.push({ path, bytes: stat.size, mtime: stat.mtimeMs })
    }
  }
  return { files, symlinks }
}

/** 列出 root/prefix 下的普通文件；符号链接不跟随也不统计，避免越出数据目录。 */
export async function filesIn(
  root: string,
  prefix = '',
): Promise<Array<{ path: string; bytes: number; mtime: number }>> {
  return (await walk(root, prefix, { stats: true, skip: new Set() })).files
}

/** 收集 root/prefix 下的符号链接路径（相对 root）；只记录，不跟随、不读取、不删除。 */
export async function symlinksIn(
  root: string,
  prefix = '',
  skip: string[] = [],
): Promise<string[]> {
  return (await walk(root, prefix, { stats: false, skip: new Set(skip) })).symlinks
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
