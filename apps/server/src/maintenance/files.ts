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

/** 不跟随符号链接，避免备份或清理越出 dataDir。 */
export async function filesIn(
  root: string,
  prefix = '',
): Promise<Array<{ path: string; bytes: number; mtime: number }>> {
  const out: Array<{ path: string; bytes: number; mtime: number }> = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`数据目录含符号链接，维护已停止：${path}`)
    if (entry.isDirectory()) out.push(...(await filesIn(root, path)))
    else if (entry.isFile()) {
      const stat = await lstat(join(root, path))
      out.push({ path, bytes: stat.size, mtime: stat.mtimeMs })
    }
  }
  return out
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
