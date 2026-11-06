import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { Asset } from '@plein/protocol'
import { type AssetStore, UploadTooLargeError } from '../assets/store'
import { type LocalAccess, LocalPathError, openLocalFile } from './local-path'
import { fetchRemote, RemoteFetchError, type RemoteOptions } from './remote'
import type { FileTickets } from './tickets'

/** 工具层用到的文件进出服务；没有就表示这个入口不开放文件进出 */
export interface FileServices {
  tickets: FileTickets
  /** 本机路径的允许范围。只在本机免登录模式有值；没有就不开放 path 与 save_to */
  local?: LocalAccess
  /** 单个文件上限（字节），与普通上传同一个配置 */
  maxUpload: number
  /** 测试用：覆盖远程下载的地址检查与解析 */
  remote?: Pick<RemoteOptions, 'allowAddress' | 'lookup' | 'timeoutMs'>
}

/** base64 内联的解码后上限；更大的文件走 request_upload 或 url */
export const MAX_BASE64_BYTES = 8 * 1024 * 1024

export class ImportError extends Error {}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
}

function lastSegment(url: URL) {
  const raw = url.pathname.split('/').pop() ?? ''
  try {
    return decodeURIComponent(raw) || 'download'
  } catch {
    return raw || 'download'
  }
}

export const mimeFromName = (name: string) => MIME_BY_EXT[extname(name).toLowerCase()]

export interface ImportSource {
  path?: string
  url?: string
  base64?: string
  name?: string
  mime?: string
}

const GENERIC = new Set(['application/octet-stream', 'binary/octet-stream'])

/**
 * 把外部来源的文件写入资产库。三种来源走同一条 AssetStore.ingest 流式写入，
 * 类型与大小的校验和界面上传一致（类型不可信时当普通文件，超限拒绝）。
 */
export async function importSource(
  assets: AssetStore,
  files: FileServices,
  ownerId: string,
  source: ImportSource,
): Promise<Asset> {
  const given = [source.path, source.url, source.base64].filter((v) => v !== undefined).length
  if (given !== 1) throw new ImportError('source 里 path、url、base64 必须且只能给一个')
  try {
    if (source.base64 !== undefined) {
      const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i.exec(source.base64)
      const text = m ? source.base64.slice(m[0].length) : source.base64
      // 解码前先按长度估算，避免为超大字符串分配内存
      if ((text.length * 3) / 4 > MAX_BASE64_BYTES + 3)
        throw new ImportError(
          `base64 内容超过 ${MAX_BASE64_BYTES / 1048576} MiB，大文件请用 request_upload 或 url`,
        )
      const buf = Buffer.from(text, 'base64')
      if (!buf.length) throw new ImportError('base64 内容为空或不合法')
      if (buf.length > MAX_BASE64_BYTES)
        throw new ImportError(
          `base64 内容超过 ${MAX_BASE64_BYTES / 1048576} MiB，大文件请用 request_upload 或 url`,
        )
      const name = source.name ?? 'untitled'
      return await assets.ingest(ownerId, Readable.from([buf]), {
        mime: source.mime ?? m?.[1] ?? mimeFromName(name) ?? 'application/octet-stream',
        name,
      })
    }
    if (source.path !== undefined) {
      if (!files.local)
        throw new ImportError('path 只在本机模式可用；请改用 base64、url 或 request_upload')
      const file = await openLocalFile(files.local, source.path, files.maxUpload)
      const name = source.name ?? file.name
      try {
        return await assets.ingest(ownerId, file.handle.createReadStream({ autoClose: false }), {
          mime: source.mime ?? mimeFromName(file.name) ?? 'application/octet-stream',
          name,
        })
      } finally {
        await file.handle.close()
      }
    }
    const remote = await fetchRemote(source.url!, { maxBytes: files.maxUpload, ...files.remote })
    const tail = lastSegment(remote.url)
    const name = source.name ?? tail
    const mime =
      source.mime ??
      (remote.mime && !GENERIC.has(remote.mime) ? remote.mime : undefined) ??
      mimeFromName(tail) ??
      'application/octet-stream'
    try {
      return await assets.ingest(ownerId, remote.body, { mime, name })
    } catch (err) {
      remote.body.destroy()
      throw err
    }
  } catch (err) {
    if (
      err instanceof LocalPathError ||
      err instanceof RemoteFetchError ||
      err instanceof UploadTooLargeError
    )
      throw new ImportError(err.message)
    throw err
  }
}
