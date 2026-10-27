import type { CDPSession, Page } from '@playwright/test'
import type { Engine } from '../../packages/canvas-core/src/engine'
import type { MediaStats } from './probe'

interface MemoryWindow {
  __plein: { engine: Engine; memoryStats?: () => unknown }
}

export interface HeapSample {
  elapsedMs: number
  usedBeforeGc: number
  usedAfterGc: number
  documents: number
  nodes: number
  listeners: number
  resources: MediaStats
  caches: unknown
}

/** GC 前的增长包含临时分配；只有 GC 后仍存活的对象才进入保留量比较。 */
export async function sampleHeap(page: Page, cdp: CDPSession, elapsedMs = 0): Promise<HeapSample> {
  await page.waitForFunction(
    () => {
      const stats = (window as unknown as MemoryWindow).__plein.engine.stats
      return (
        stats.previews.pending === 0 &&
        stats.textures.inFlightLoads === 0 &&
        stats.previewRevision === stats.renderedPreviewRevision
      )
    },
    null,
    { timeout: 60_000 },
  )
  const before = await cdp.send('Runtime.getHeapUsage')
  await cdp.send('HeapProfiler.collectGarbage')
  const after = await cdp.send('Runtime.getHeapUsage')
  const dom = await cdp.send('Memory.getDOMCounters')
  const state = await page.evaluate(() => {
    const { engine, memoryStats } = (window as unknown as MemoryWindow).__plein
    return { resources: engine.stats, caches: memoryStats?.() ?? null }
  })
  if (
    state.resources.previews.failed ||
    state.resources.textures.loadErrors ||
    state.resources.textures.unloadErrors
  )
    throw new Error('Memory fixture has failed media resources')
  return {
    elapsedMs,
    usedBeforeGc: before.usedSize,
    usedAfterGc: after.usedSize,
    documents: dom.documents,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    ...state,
  }
}

/** 每批都真正进入高细节视口，再删除并清撤销，排除仍可撤销的正文。 */
export async function churnMarkdown(page: Page, batches: number) {
  for (let batch = 0; batch < batches; batch++) {
    await page.evaluate((batch) => {
      const engine = (window as unknown as MemoryWindow).__plein.engine
      const elements = Array.from({ length: 8 }, (_, i) => ({
        id: `memory-${batch}-${i}`,
        kind: 'markdown' as const,
        x: (i % 4) * 320,
        y: Math.floor(i / 4) * 220,
        w: 300,
        h: 200,
        rotation: 0,
        z: `a${i}`,
        parentId: null,
        locked: false,
        // 每份正文内容独立，不能让字符串共享掩盖保留。
        text: Array.from(
          { length: 1024 },
          (_, line) => `${batch}-${i}-${line}: memory retention fixture ${'x'.repeat(28)}\n`,
        ).join(''),
      }))
      engine.paste({ plein: 1, elements, edges: [] })
      engine.zoomToFit(engine.selection.values())
      engine.zoomTo(1)
    }, batch)
    await page.waitForFunction(() => document.querySelectorAll('[data-markdown-id]').length === 8)
    // ResizeObserver 的量高需要提交布局后的帧，不能创建后立即删除。
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await page.evaluate(() => {
      const engine = (window as unknown as MemoryWindow).__plein.engine
      engine.deleteSelection()
      engine.doc.undo.clear()
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-markdown-id]').length === 0)
  }
}

export async function measureMarkdownRetention(page: Page, cdp: CDPSession) {
  // 先预热字体、Markdown 渲染和 Pixi，保留同一个引擎测删除后的增长。
  await churnMarkdown(page, 2)
  const before = await sampleHeap(page, cdp)
  await churnMarkdown(page, 12)
  const after = await sampleHeap(page, cdp)
  return { before, after, retainedBytes: Math.max(0, after.usedAfterGc - before.usedAfterGc) }
}

export async function measureSession(
  page: Page,
  cdp: CDPSession,
  durationMs: number,
  interact: () => Promise<void>,
  iterations?: number,
) {
  await interact()
  const baseline = await sampleHeap(page, cdp)
  const start = performance.now()
  const samples = [{ ...baseline, iteration: 0 }]
  let completed = 0
  while (
    iterations === undefined ? performance.now() - start < durationMs : completed < iterations
  ) {
    await interact()
    completed++
    if (
      iterations === undefined
        ? performance.now() - start >= samples.at(-1)!.elapsedMs + 10_000
        : completed % 4 === 0
    )
      samples.push({
        ...(await sampleHeap(page, cdp, performance.now() - start)),
        iteration: completed,
      })
  }
  if (!completed) throw new Error('Session fixture did not execute any measured interactions')
  if (samples.at(-1)!.iteration !== completed)
    samples.push({
      ...(await sampleHeap(page, cdp, performance.now() - start)),
      iteration: completed,
    })
  return {
    samples,
    iterations: completed,
    retainedBytes: Math.max(0, samples.at(-1)!.usedAfterGc - samples[0]!.usedAfterGc),
    // 末半段增量单独记录，避免把一次性预热当成持续泄漏。
    tailBytes: samples.at(-1)!.usedAfterGc - samples[Math.floor(samples.length / 2)]!.usedAfterGc,
  }
}
