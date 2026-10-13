import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Asset, AssetKind, AssetVariant } from '@plein/protocol'
import { and, eq } from 'drizzle-orm'
import type { DB } from '../storage/db'
import { assets } from '../storage/schema'
import { FILMSTRIP_FRAMES } from '@plein/protocol'
import {
  audioPeaks,
  audioWaveform,
  hasFfmpeg,
  imageThumb,
  type Probe,
  probeImage,
  probeMedia,
  videoFilmstrip,
  videoPoster,
} from './media'

/** 每种衍生物的文件扩展名与 MIME */
export const VARIANT_TYPES: Record<AssetVariant, { ext: string; mime: string }> = {
  'thumb-256': { ext: 'webp', mime: 'image/webp' },
  'thumb-1024': { ext: 'webp', mime: 'image/webp' },
  poster: { ext: 'webp', mime: 'image/webp' },
  waveform: { ext: 'png', mime: 'image/png' },
  filmstrip: { ext: 'webp', mime: 'image/webp' },
  peaks: { ext: 'json', mime: 'application/json' },
}

/** 第一次请求时才生成的衍生物（只有剪辑时间线用得上，不拖慢上传） */
const LAZY_VARIANTS: Partial<Record<AssetVariant, AssetKind[]>> = {
  filmstrip: ['video'],
  peaks: ['video', 'audio'],
}

/** 浏览器常见但 sharp 处理不了或不该转码的图片，只存原图 */
const PASSTHROUGH_IMAGES = new Set(['image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'])

export class UploadTooLargeError extends Error {}

type AssetRow = typeof assets.$inferSelect

function toAsset(r: AssetRow): Asset {
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    name: r.name,
    size: r.size,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    duration: r.duration ?? undefined,
    variants: JSON.parse(r.variants) as AssetVariant[],
    createdAt: r.created_at,
  }
}

function normalizeMime(mime: string) {
  const m = mime.split(';')[0]!.trim().toLowerCase()
  return /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/.test(m) ? m : 'application/octet-stream'
}

function kindOf(mime: string): AssetKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

/**
 * 内容寻址的资产存储：原文件按 SHA-256 放在 assets/<前两位>/<哈希>，
 * 衍生物放在旁边（<哈希>.<衍生物>.<扩展名>）。同一内容只存一份。
 */
export class AssetStore {
  private root: string
  private tmp: string
  /** 正在生成的按需衍生物，同一个只跑一次 */
  private pending = new Map<string, Promise<boolean>>()

  constructor(
    dataDir: string,
    private db: DB,
    private maxSize: number,
  ) {
    this.root = join(dataDir, 'assets')
    this.tmp = join(dataDir, 'tmp')
  }

  async init() {
    await mkdir(this.root, { recursive: true })
    await rm(this.tmp, { recursive: true, force: true })
    await mkdir(this.tmp, { recursive: true })
  }

  /** 新建一个临时目录（在数据目录内，启动时清空） */
  tempDir() {
    return mkdtemp(join(this.tmp, 'job-'))
  }

  originalPath(id: string) {
    return join(this.root, id.slice(0, 2), id)
  }

  variantPath(id: string, v: AssetVariant) {
    return join(this.root, id.slice(0, 2), `${id}.${v}.${VARIANT_TYPES[v].ext}`)
  }

  get(ownerId: string, id: string): Asset | null {
    const row = this.db
      .select()
      .from(assets)
      .where(and(eq(assets.owner_id, ownerId), eq(assets.id, id)))
      .get()
    return row ? toAsset(row) : null
  }

  /** 流式写入临时文件并计算哈希，再移动到内容地址；已存在则直接复用 */
  async ingest(
    ownerId: string,
    body: ReadableStream<Uint8Array> | Readable,
    meta: { mime: string; name: string },
  ): Promise<Asset> {
    // 类型来自客户端或插件，不可信：格式不对的一律当作普通文件
    meta = { ...meta, mime: normalizeMime(meta.mime) }
    const tmpFile = join(this.tmp, randomUUID())
    const hash = createHash('sha256')
    let size = 0
    const max = this.maxSize
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        if (size > max)
          return cb(new UploadTooLargeError(`文件超过上限 ${Math.round(max / 1048576)} MB`))
        hash.update(chunk)
        cb(null, chunk)
      },
    })
    const input = body instanceof Readable ? body : Readable.fromWeb(body as never)
    try {
      await pipeline(input, counter, createWriteStream(tmpFile))
    } catch (err) {
      await rm(tmpFile, { force: true })
      throw err
    }
    const id = hash.digest('hex')

    const existing = this.get(ownerId, id)
    if (existing) {
      await rm(tmpFile, { force: true })
      return existing
    }

    // 同一内容的文件与衍生物在所有者之间共享；rename 是原子的，并发上传同一内容也安全
    const kind = kindOf(meta.mime)
    const variants: AssetVariant[] = []
    let probe: Probe | null = null
    await mkdir(join(this.root, id.slice(0, 2)), { recursive: true })
    await rename(tmpFile, this.originalPath(id))

    const src = this.originalPath(id)
    try {
      ;({ probe } = await this.derive(id, src, kind, meta.mime, variants))
    } catch (err) {
      // 文件损坏或格式不支持：仍然保存原文件，只是没有尺寸和衍生物
      console.warn(`[assets] 处理 ${meta.name} 失败：`, (err as Error).message)
    }

    const asset: Asset = {
      id,
      kind,
      mime: meta.mime,
      name: meta.name,
      size,
      width: probe?.width,
      height: probe?.height,
      duration: probe?.duration,
      variants,
      createdAt: Date.now(),
    }
    this.db
      .insert(assets)
      .values({
        id,
        owner_id: ownerId,
        kind,
        mime: asset.mime,
        name: asset.name,
        size,
        width: asset.width ?? null,
        height: asset.height ?? null,
        duration: asset.duration ?? null,
        variants: JSON.stringify(variants),
        created_at: asset.createdAt,
      })
      .onConflictDoNothing()
      .run()
    return this.get(ownerId, id) ?? asset
  }

  /**
   * 确保按需衍生物存在：已有直接返回 true；资产类型不对、没有 ffmpeg 或生成失败返回 false。
   * 生成后记进所有持有该内容的记录里（同一内容的衍生物本来就是共享的）。
   */
  async ensureVariant(asset: Asset, v: AssetVariant): Promise<boolean> {
    if (asset.variants.includes(v)) return true
    if (!LAZY_VARIANTS[v]?.includes(asset.kind) || !(await hasFfmpeg())) return false
    const key = `${asset.id}.${v}`
    let job = this.pending.get(key)
    if (!job) {
      job = this.makeLazy(asset, v).finally(() => this.pending.delete(key))
      this.pending.set(key, job)
    }
    return job
  }

  private async makeLazy(asset: Asset, v: AssetVariant) {
    const src = this.originalPath(asset.id)
    const out = this.variantPath(asset.id, v)
    const exists = await stat(out).then(
      () => true,
      () => false,
    )
    if (!exists) {
      const part = `${out}.${randomUUID()}.part`
      try {
        if (v === 'filmstrip') {
          if (!asset.duration || !asset.width) return false
          await videoFilmstrip(src, part, asset.duration, FILMSTRIP_FRAMES)
        } else {
          const probe = await probeMedia(src)
          if (!probe.hasAudio) return false
          await audioPeaks(src, part)
        }
        await rename(part, out)
      } catch (err) {
        await rm(part, { force: true })
        console.warn(`[assets] 生成 ${v} 失败：`, (err as Error).message)
        return false
      }
    }
    const rows = this.db.select().from(assets).where(eq(assets.id, asset.id)).all()
    for (const r of rows) {
      const list = JSON.parse(r.variants) as AssetVariant[]
      if (list.includes(v)) continue
      this.db
        .update(assets)
        .set({ variants: JSON.stringify([...list, v]) })
        .where(and(eq(assets.id, r.id), eq(assets.owner_id, r.owner_id)))
        .run()
    }
    return true
  }

  /** 读取元数据并生成衍生物；已存在的衍生物跳过 */
  private async derive(
    id: string,
    src: string,
    kind: AssetKind,
    mime: string,
    variants: AssetVariant[],
  ): Promise<{ probe: Probe | null }> {
    const make = async (v: AssetVariant, fn: (out: string) => Promise<void>) => {
      const out = this.variantPath(id, v)
      const ok = await stat(out).then(
        () => true,
        () => false,
      )
      if (!ok) {
        const part = `${out}.${randomUUID()}.part`
        await fn(part)
        await rename(part, out)
      }
      variants.push(v)
    }

    if (kind === 'image' && !PASSTHROUGH_IMAGES.has(mime)) {
      const probe = await probeImage(src)
      await make('thumb-256', (out) => imageThumb(src, out, 256))
      await make('thumb-1024', (out) => imageThumb(src, out, 1024))
      return { probe }
    }
    if ((kind === 'video' || kind === 'audio') && (await hasFfmpeg())) {
      const probe = await probeMedia(src)
      if (kind === 'video' && probe.hasVideo)
        await make('poster', (out) => videoPoster(src, out, probe.duration))
      if (kind === 'audio' && probe.hasAudio)
        await make('waveform', (out) => audioWaveform(src, out))
      return { probe }
    }
    return { probe: null }
  }
}
