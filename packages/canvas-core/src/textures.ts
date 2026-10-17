import { Assets, type Texture } from 'pixi.js'

export const TEXTURE_BUDGET_BYTES = 512 * 1024 * 1024
export const TEXTURE_IDLE_LIMIT = 128
export const TEXTURE_IDLE_MS = 30_000
export const TEXTURE_LOAD_CONCURRENCY = 4

export interface TextureLease<T = Texture> {
  promise: Promise<T>
  release(): void
}

export interface TextureOwner<T = Texture> {
  acquire(url: string): TextureLease<T>
  dispose(): void
}

export interface TexturePoolStats {
  owners: number
  activeLeases: number
  pinnedTextures: number
  idleTextures: number
  queuedLoads: number
  inFlightLoads: number
  unloadingTextures: number
  readyTextures: number
  /** Unique decoded RGBA sources; not a measurement of renderer/GPU memory. */
  estimatedTextureBytes: number
  pinnedEstimatedBytes: number
  pinnedOverBudgetBytes: number
  budgetBytes: number
  cacheHits: number
  loadsStarted: number
  evictions: number
  loadErrors: number
  unloadErrors: number
}

export interface TexturePoolOptions<T> {
  load(url: string): Promise<T>
  unload(url: string): Promise<void>
  estimateBytes(texture: T): number
  budgetBytes?: number
  idleLimit?: number
  idleMs?: number
  concurrency?: number
  now?: () => number
}

interface Entry<T> {
  url: string
  state: 'queued' | 'loading' | 'ready'
  refs: number
  bytes: number
  idleAt: number
  promise: Promise<T>
  resolve(texture: T): void
  reject(error: unknown): void
  predecessor?: Promise<void>
}

function cancelled() {
  return new DOMException('Texture lease released before loading', 'AbortError')
}

/** All owners share Pixi's URL cache; only this pool may unload leased previews. */
export class TexturePool<T> {
  private entries = new Map<string, Entry<T>>()
  private unloading = new Map<string, { promise: Promise<void>; bytes: number }>()
  private owners = new Set<TextureOwner<T>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pumping = false
  private inFlight = 0
  private hits = 0
  private loads = 0
  private evicted = 0
  private errors = 0
  private unloadErrors = 0
  private budget: number
  private idleLimit: number
  private idleMs: number
  private concurrency: number
  private now: () => number

  constructor(private options: TexturePoolOptions<T>) {
    this.budget = options.budgetBytes ?? TEXTURE_BUDGET_BYTES
    this.idleLimit = options.idleLimit ?? TEXTURE_IDLE_LIMIT
    this.idleMs = options.idleMs ?? TEXTURE_IDLE_MS
    this.concurrency = Math.max(1, options.concurrency ?? TEXTURE_LOAD_CONCURRENCY)
    this.now = options.now ?? Date.now
  }

  createOwner(): TextureOwner<T> {
    const leases = new Set<TextureLease<T>>()
    let disposed = false
    const owner: TextureOwner<T> = {
      acquire: (url) => {
        if (disposed) throw new Error('Texture owner is disposed')
        this.owners.add(owner)
        const lease = this.acquire(url)
        let released = false
        const owned: TextureLease<T> = {
          promise: lease.promise,
          release() {
            if (released) return
            released = true
            leases.delete(owned)
            lease.release()
          },
        }
        leases.add(owned)
        return owned
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const lease of [...leases]) lease.release()
        this.owners.delete(owner)
        this.trim()
      },
    }
    return owner
  }

  get stats(): TexturePoolStats {
    let activeLeases = 0
    let pinnedTextures = 0
    let idleTextures = 0
    let queuedLoads = 0
    let readyTextures = 0
    let estimatedTextureBytes = 0
    let pinnedEstimatedBytes = 0
    for (const entry of this.entries.values()) {
      activeLeases += entry.refs
      if (entry.refs > 0) pinnedTextures++
      if (entry.state === 'queued') queuedLoads++
      if (entry.state !== 'ready') continue
      readyTextures++
      estimatedTextureBytes += entry.bytes
      if (entry.refs > 0) pinnedEstimatedBytes += entry.bytes
      else idleTextures++
    }
    for (const entry of this.unloading.values()) estimatedTextureBytes += entry.bytes
    return {
      owners: this.owners.size,
      activeLeases,
      pinnedTextures,
      idleTextures,
      queuedLoads,
      inFlightLoads: this.inFlight,
      unloadingTextures: this.unloading.size,
      readyTextures,
      estimatedTextureBytes,
      pinnedEstimatedBytes,
      pinnedOverBudgetBytes: Math.max(0, pinnedEstimatedBytes - this.budget),
      budgetBytes: this.budget,
      cacheHits: this.hits,
      loadsStarted: this.loads,
      evictions: this.evicted,
      loadErrors: this.errors,
      unloadErrors: this.unloadErrors,
    }
  }

  private acquire(source: string): TextureLease<T> {
    const url = new URL(source, globalThis.document?.baseURI ?? 'http://localhost/').href
    let entry = this.entries.get(url)
    if (entry) this.hits++
    else {
      let resolve!: (texture: T) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
      })
      // A queued lease can be released before its consumer attaches a handler.
      void promise.catch(() => {})
      entry = {
        url,
        state: 'queued',
        refs: 0,
        bytes: 0,
        idleAt: 0,
        promise,
        resolve,
        reject,
        predecessor: this.unloading.get(url)?.promise,
      }
      this.entries.set(url, entry)
    }
    const acquired = entry
    acquired.refs++
    this.schedulePump()
    this.trim()
    let released = false
    return {
      promise: acquired.promise,
      release: () => {
        if (released) return
        released = true
        acquired.refs--
        if (acquired.refs > 0) return
        acquired.idleAt = this.now()
        if (acquired.state === 'queued') {
          if (this.entries.get(url) === acquired) this.entries.delete(url)
          acquired.reject(cancelled())
        }
        this.trim()
      },
    }
  }

  private schedulePump() {
    if (this.pumping) return
    this.pumping = true
    queueMicrotask(() => {
      this.pumping = false
      for (const entry of this.entries.values()) {
        if (this.inFlight >= this.concurrency) break
        if (entry.state !== 'queued' || entry.refs === 0) continue
        entry.state = 'loading'
        this.inFlight++
        void this.load(entry)
      }
    })
  }

  private async load(entry: Entry<T>) {
    try {
      // Assets.unload destroys its shared texture. A new generation waits for it.
      await entry.predecessor
      if (entry.refs === 0) {
        if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url)
        entry.reject(cancelled())
        return
      }
      this.loads++
      const texture = await this.options.load(entry.url)
      entry.bytes = Math.max(0, this.options.estimateBytes(texture))
      entry.state = 'ready'
      if (entry.refs === 0) {
        // No consumer ever presented this result; do not retain abandoned work.
        entry.reject(cancelled())
        this.unload(entry)
      } else entry.resolve(texture)
    } catch (error) {
      this.errors++
      if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url)
      entry.reject(error)
    } finally {
      this.inFlight--
      this.trim()
      this.schedulePump()
    }
  }

  private unload(entry: Entry<T>) {
    if (entry.refs > 0 || entry.state !== 'ready') return
    if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url)
    this.evicted++
    const promise = Promise.resolve()
      .then(() => this.options.unload(entry.url))
      .catch(() => {
        this.unloadErrors++
      })
      .finally(() => {
        if (this.unloading.get(entry.url)?.promise === promise) this.unloading.delete(entry.url)
      })
    this.unloading.set(entry.url, { promise, bytes: entry.bytes })
  }

  private trim() {
    clearTimeout(this.timer)
    this.timer = undefined
    let bytes = 0
    const idle: Entry<T>[] = []
    for (const entry of this.entries.values()) {
      if (entry.state !== 'ready') continue
      bytes += entry.bytes
      if (entry.refs === 0) idle.push(entry)
    }
    idle.sort((a, b) => a.idleAt - b.idleAt)
    const now = this.now()
    let idleCount = idle.length
    for (const entry of idle) {
      if (
        this.owners.size === 0 ||
        bytes > this.budget ||
        idleCount > this.idleLimit ||
        now - entry.idleAt >= this.idleMs
      ) {
        bytes -= entry.bytes
        idleCount--
        this.unload(entry)
      } else if (this.timer === undefined) {
        this.timer = setTimeout(() => this.trim(), Math.max(1, entry.idleAt + this.idleMs - now))
      }
    }
  }
}

/** Pixi may upload a source into several contexts; these are source bytes only. */
export function estimateTextureBytes(texture: Texture) {
  const source = texture.source
  const mipmaps = source.autoGenerateMipmaps || source.mipLevelCount > 1
  return Math.ceil(source.pixelWidth * source.pixelHeight * 4 * (mipmaps ? 4 / 3 : 1))
}

export const previewTextures = new TexturePool<Texture>({
  load: (url) => Assets.load<Texture>({ src: url, parser: 'texture' }),
  unload: (url) => Assets.unload(url),
  estimateBytes: estimateTextureBytes,
})

/** A view keeps its small preview until an upgrade is ready, but never a different asset. */
export class TextureSlot<T> {
  texture: T | undefined
  private source: string | undefined
  private requested: string | undefined
  private active: TextureLease<T> | undefined
  private pending: TextureLease<T> | undefined
  private generation = 0
  private destroyed = false
  private failed = false

  constructor(private owner: TextureOwner<T>) {}

  get status() {
    return {
      requested: !!this.source,
      ready: !!this.texture,
      pending: !!this.pending,
      failed: this.failed,
    }
  }

  setSource(source: string | undefined, url: string | undefined, loaded: (texture: T) => void) {
    if (this.destroyed) return
    if (source !== this.source || !url) {
      this.clear()
      this.source = source
    }
    if (!url) {
      this.failed = !!source
      return
    }
    if (this.requested === url) return
    this.failed = false
    this.pending?.release()
    const generation = ++this.generation
    this.requested = url
    const lease = this.owner.acquire(url)
    this.pending = lease
    void lease.promise.then(
      (texture) => {
        if (this.destroyed || generation !== this.generation) return
        this.active?.release()
        this.active = lease
        this.pending = undefined
        this.texture = texture
        loaded(texture)
      },
      () => {
        if (this.destroyed || generation !== this.generation) return
        lease.release()
        this.pending = undefined
        this.requested = undefined
        this.failed = true
      },
    )
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.clear()
  }

  private clear() {
    this.generation++
    this.active?.release()
    this.pending?.release()
    this.active = this.pending = undefined
    this.texture = undefined
    this.requested = undefined
    this.failed = false
  }
}
