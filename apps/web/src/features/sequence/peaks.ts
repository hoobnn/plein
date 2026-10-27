import type { AudioPeaks } from '@plein/protocol'
import { assetUrls } from '../../api/client'

/** 100 peaks/s 下约 2 小时 47 分素材；只限制共享缓存，活跃组件仍持有自己的结果。 */
const MAX_CACHED_PEAKS = 1_000_000

/** 资产不可变：请求中去重，成功结果按峰值总量保留最近使用的素材，失败下次可重试。 */
export class PeaksCache {
  private pending = new Map<string, Promise<AudioPeaks | null>>()
  private ready = new Map<string, AudioPeaks>()
  private size = 0

  constructor(private readonly budget = MAX_CACHED_PEAKS) {}

  load(assetId: string): Promise<AudioPeaks | null> {
    const cached = this.ready.get(assetId)
    if (cached) {
      this.ready.delete(assetId)
      this.ready.set(assetId, cached)
      return Promise.resolve(cached)
    }
    let request = this.pending.get(assetId)
    if (!request) {
      request = fetch(assetUrls.variant(assetId, 'peaks'))
        .then((r) => (r.ok ? r.json() : null))
        .then((value: unknown): AudioPeaks | null => {
          if (!value || typeof value !== 'object') return null
          const peaks = value as AudioPeaks
          return Number.isFinite(peaks.rate) &&
            peaks.rate > 0 &&
            Array.isArray(peaks.peaks) &&
            peaks.peaks.every((peak) => Number.isFinite(peak) && peak >= 0)
            ? peaks
            : null
        })
        .catch(() => null)
        .then((peaks) => {
          this.pending.delete(assetId)
          if (peaks) this.retain(assetId, peaks)
          return peaks
        })
      this.pending.set(assetId, request)
    }
    return request
  }

  private retain(assetId: string, peaks: AudioPeaks) {
    // 空波形也是成功结果，至少计一个单位，避免零权重条目无限增长。
    const size = Math.max(1, peaks.peaks.length)
    if (size > this.budget) return
    while (this.size + size > this.budget) {
      const oldest = this.ready.keys().next().value!
      this.size -= Math.max(1, this.ready.get(oldest)!.peaks.length)
      this.ready.delete(oldest)
    }
    this.ready.set(assetId, peaks)
    this.size += size
  }
}

export const peaksCache = new PeaksCache()
