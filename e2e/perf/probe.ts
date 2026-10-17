import type { BrowserContext, Page } from '@playwright/test'
import type { TexturePoolStats } from '../../packages/canvas-core/src/textures'

export interface MediaStats {
  elements: number
  visible: number
  residentBodies: number
  visibleBodies: number
  offscreenBodies: number
  previews: { total: number; ready: number; pending: number; failed: number }
  textures: TexturePoolStats
  previewRevision: number
  renderedPreviewRevision: number
}

export interface OpenSample {
  engineReadyMs: number
  firstVisiblePreviewMs: number
  visibleMediaSettledMs: number
  stats: MediaStats
  requests: {
    count: number
    failed: number
    variants: Record<string, number>
    runtimeErrors: string[]
  }
}

interface OpenProbe {
  engineReadyMs?: number
  firstVisiblePreviewMs?: number
  visibleMediaSettledMs?: number
  stats?: MediaStats
  failure?: string
  stop(): void
}

export interface PerfPageWindow {
  __plein?: { engine: { stats: MediaStats } }
  __pleinOpenProbe?: OpenProbe
  __retiredMediaStats?: () => MediaStats
}

/** Polls submitted Pixi preview revisions, not merely a mounted engine or an HTTP response. */
function instrumentOpen(expected: number) {
  const state = window as unknown as PerfPageWindow
  state.__pleinOpenProbe?.stop()
  let alive = true
  const start = performance.now()
  const probe: OpenProbe = {
    stop: () => {
      alive = false
    },
  }
  state.__pleinOpenProbe = probe
  const tick = () => {
    if (!alive) return
    const engine = state.__plein?.engine
    if (engine) {
      const stats = engine.stats
      probe.engineReadyMs ??= performance.now() - start
      probe.stats = stats
      if (stats.previews.failed || stats.textures.loadErrors || stats.textures.unloadErrors) {
        probe.failure = `Media preview failed: ${JSON.stringify(stats.previews)}`
        return
      }
      const submitted =
        stats.previewRevision > 0 && stats.renderedPreviewRevision === stats.previewRevision
      if (submitted && stats.previews.ready > 0)
        probe.firstVisiblePreviewMs ??= performance.now() - start
      if (
        submitted &&
        stats.elements === expected &&
        stats.previews.total > 0 &&
        stats.previews.ready === stats.previews.total &&
        stats.previews.pending === 0
      ) {
        probe.visibleMediaSettledMs = performance.now() - start
        return
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export async function installOpenProbe(page: Page, expected: number) {
  await page.addInitScript(instrumentOpen, expected)
}

/** tsx preserves function names with this helper, including callbacks serialized by Playwright. */
export async function installFunctionSerialization(context: BrowserContext) {
  await context.addInitScript({ content: 'globalThis.__name ??= (target) => target' })
}

export async function resetOpenProbe(page: Page, expected: number) {
  await page.evaluate(instrumentOpen, expected)
}

export async function waitEngine(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as PerfPageWindow).__plein?.engine, null, {
    timeout: 60_000,
  })
}

export function watchAssetRequests(page: Page) {
  const requests: OpenSample['requests'] = { count: 0, failed: 0, variants: {}, runtimeErrors: [] }
  const response = (res: { url(): string; status(): number }) => {
    const match = /\/api\/assets\/[^/?]+\/(thumb-256|thumb-1024|poster|waveform)(?:[?#]|$)/.exec(
      res.url(),
    )
    if (!match) return
    requests.count++
    if (res.status() >= 400) requests.failed++
    const variant = match[1]!
    requests.variants[variant] = (requests.variants[variant] ?? 0) + 1
  }
  const failed = (request: { url(): string }) => {
    if (/\/api\/assets\//.test(request.url())) requests.failed++
  }
  const runtimeError = (error: Error) => {
    requests.runtimeErrors.push(error.message)
  }
  page.on('response', response)
  page.on('requestfailed', failed)
  page.on('pageerror', runtimeError)
  return {
    requests,
    stop: () => {
      page.off('response', response)
      page.off('requestfailed', failed)
      page.off('pageerror', runtimeError)
    },
  }
}

export async function readOpenSample(
  page: Page,
  requests: OpenSample['requests'],
  timeout = 60_000,
): Promise<OpenSample> {
  if (requests.runtimeErrors.length)
    throw new Error(`Canvas page error: ${requests.runtimeErrors.join('; ')}`)
  let runtimeError = (_error: Error) => {}
  const failed = new Promise<never>((_resolve, reject) => {
    runtimeError = (error) => reject(new Error(`Canvas page error: ${error.message}`))
    page.on('pageerror', runtimeError)
  })
  try {
    await Promise.race([
      page.waitForFunction(
        () => {
          const probe = (window as unknown as PerfPageWindow).__pleinOpenProbe
          return probe?.failure || probe?.visibleMediaSettledMs !== undefined
        },
        null,
        { timeout },
      ),
      failed,
    ])
  } catch (error) {
    const probe = await page.evaluate(() => (window as unknown as PerfPageWindow).__pleinOpenProbe)
    throw new Error(`Media preview did not settle: ${JSON.stringify({ probe, requests })}`, {
      cause: error,
    })
  } finally {
    page.off('pageerror', runtimeError)
  }
  const probe = await page.evaluate(() => {
    const { stop: _stop, ...result } = (window as unknown as PerfPageWindow).__pleinOpenProbe!
    return result
  })
  if (probe.failure || requests.failed || requests.runtimeErrors.length)
    throw new Error(probe.failure ?? `Media HTTP failures: ${requests.failed}`)
  if (
    probe.engineReadyMs === undefined ||
    probe.firstVisiblePreviewMs === undefined ||
    probe.visibleMediaSettledMs === undefined ||
    !probe.stats
  )
    throw new Error('Media preview readiness was not observed')
  return {
    engineReadyMs: probe.engineReadyMs,
    firstVisiblePreviewMs: probe.firstVisiblePreviewMs,
    visibleMediaSettledMs: probe.visibleMediaSettledMs,
    stats: probe.stats,
    requests: structuredClone(requests),
  }
}

export function readMediaStats(page: Page): Promise<MediaStats> {
  return page.evaluate(() => (window as unknown as PerfPageWindow).__plein!.engine.stats)
}
