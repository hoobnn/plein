/** 每个 Provider 一个：限制并发数和每分钟请求数 */
export class Limiter {
  private active = 0
  private queue: Array<() => void> = []
  private starts: number[] = []

  constructor(
    private concurrency = 4,
    private perMinute = Number.POSITIVE_INFINITY,
  ) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }

  private async acquire(signal?: AbortSignal) {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          this.queue = this.queue.filter((w) => w !== wake)
          reject(signal?.reason)
        }
        this.queue.push(wake)
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    this.active++
    // 每分钟请求数：滑动窗口
    for (;;) {
      const now = Date.now()
      this.starts = this.starts.filter((t) => now - t < 60_000)
      if (this.starts.length < this.perMinute) break
      await sleep(60_000 - (now - this.starts[0]!), signal).catch((err) => {
        this.active--
        throw err
      })
    }
    this.starts.push(Date.now())
  }
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
