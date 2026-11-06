import { constants, realpathSync } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class LocalPathError extends Error {}

/** 允许读写的本机目录。只在本机免登录模式创建；没有这个对象就不开放 path / save_to */
export interface LocalAccess {
  /** 允许的根目录（已解析真实路径） */
  roots: string[]
  /** 即使在根目录之内也拒绝的目录（数据目录里有密钥和令牌） */
  denied: string[]
}

/** 默认只开放用户主目录；PLEIN_IMPORT_ROOTS（路径分隔符分隔）可以改 */
export async function localAccess(dataDir: string, roots?: string[]): Promise<LocalAccess> {
  const list = roots?.length ? roots : [homedir()]
  const real = await Promise.all(list.map((r) => realpath(resolve(r)).catch(() => resolve(r))))
  return { roots: real, denied: [await realpath(dataDir).catch(() => resolve(dataDir))] }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 路径检查：必须在允许目录内、不在被拒目录里、不含隐藏目录（.ssh、.aws、.config…）、不经过 ~/Library */
function check(access: LocalAccess, real: string) {
  const root = access.roots.find((r) => inside(r, real))
  if (!root) throw new LocalPathError('路径不在允许的目录内')
  if (access.denied.some((d) => inside(d, real)))
    throw new LocalPathError('路径在 Plein 数据目录内，不允许访问')
  const parts = relative(root, real).split(sep).filter(Boolean)
  if (parts.some((p) => p.startsWith('.')))
    throw new LocalPathError('不允许访问隐藏目录或隐藏文件（如 .ssh、.config）')
  if (root === realpathSync(homedir()) && parts[0] === 'Library')
    throw new LocalPathError('不允许访问 ~/Library')
}

function expand(path: string) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 打开本机文件用于读取。解析符号链接后再检查目录，最后用 O_NOFOLLOW 打开真实路径，
 * 所以符号链接指到目录外、或检查后被换成符号链接都读不到。
 */
export async function openLocalFile(
  access: LocalAccess,
  input: string,
  maxBytes: number,
): Promise<{ handle: FileHandle; size: number; name: string }> {
  const given = expand(input)
  if (!isAbsolute(given)) throw new LocalPathError('path 必须是绝对路径')
  let real: string
  try {
    real = await realpath(given)
  } catch {
    throw new LocalPathError('文件不存在')
  }
  check(access, real)
  let handle: FileHandle | undefined
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) throw new LocalPathError('path 不是普通文件')
    if (info.size > maxBytes)
      throw new LocalPathError(`文件超过上限 ${Math.round(maxBytes / 1048576)} MB`)
    return { handle, size: info.size, name: basename(real) }
  } catch (err) {
    await handle?.close()
    if (err instanceof LocalPathError) throw err
    throw new LocalPathError('无法读取该文件')
  }
}

/**
 * 解析要写入的本机路径（save_to）：目录必须已在允许范围内，文件不能已存在（不覆盖），
 * 目标本身不能是符号链接。返回可以用 wx 标志创建的真实路径。
 */
export async function resolveSaveTarget(access: LocalAccess, input: string): Promise<string> {
  const given = expand(input)
  if (!isAbsolute(given)) throw new LocalPathError('save_to 必须是绝对路径')
  const dir = await realpath(dirname(given)).catch(() => null)
  if (!dir) throw new LocalPathError('save_to 所在目录不存在')
  const target = join(dir, basename(given))
  check(access, target)
  const info = await lstat(target).catch(() => null)
  if (info) throw new LocalPathError('save_to 指向的文件已存在，不会覆盖；换一个文件名')
  return target
}
