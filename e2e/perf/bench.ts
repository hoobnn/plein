/**
 * 渲染性能基准：真服务 + e2e 构建的前端，在无头 Chromium 里驱动画布并读 CDP 指标。
 *
 *   pnpm perf            # 先构建 apps/web/dist-e2e，再跑全部场景（约 10 分钟）
 *   PERF_N=3000 pnpm perf
 *
 * 容器里的 Chromium 用软件光栅（SwiftShader），GPU 帧率不可信；
 * 这里只看主线程：每帧脚本 / 布局 / 样式耗时、长任务、DOM 写入次数，以及打开画布的耗时。
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test'
import { createMediaFixture, MEDIA_FIXTURE_VERSION, seedMediaCanvas } from './fixtures'
import {
  installFunctionSerialization,
  installOpenProbe,
  type OpenSample,
  readOpenSample,
  resetOpenProbe,
  watchAssetRequests,
} from './probe'
import { assertRendererMode, comparePerfReports, type PerfReport } from './report'

/** 被测的仓库根目录：服务端和前端构建都从这里取；对比改动前后时指向另一个检出 */
const ROOT = process.env.PERF_ROOT ?? join(import.meta.dirname, '../..')
const PORT = Number(process.env.PERF_PORT ?? 8791)
const BASE = `http://127.0.0.1:${PORT}`
const N = Number(process.env.PERF_N ?? 1000)
/** 每个场景跑几轮取中位数 */
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 3)
const WEB_DIST = process.env.PERF_DIST ?? join(ROOT, 'apps/web/dist-e2e')
const failureContext: Record<string, unknown> = {
  environment: {
    runtime: `node ${process.versions.node}`,
    platform: `${process.platform}/${process.arch}`,
    renderMode: process.env.PERF_RENDERER ?? 'software',
  },
  fixture: { version: MEDIA_FIXTURE_VERSION, elements: N },
  rounds: ROUNDS,
}

function writeReport(value: unknown) {
  if (!process.env.PERF_OUTPUT) return
  mkdirSync(dirname(process.env.PERF_OUTPUT), { recursive: true })
  writeFileSync(process.env.PERF_OUTPUT, `${JSON.stringify(value, null, 2)}\n`)
}

function buildFingerprint() {
  return createHash('sha256')
    .update(readFileSync(join(WEB_DIST, 'index.html')))
    .digest('hex')
}

interface Engine {
  camera: { zoom: number; viewRect: { x: number; y: number; w: number; h: number } }
  selection: { set(ids: string[]): void; clear(): void; values(): string[] }
  scene: {
    query(r: { x: number; y: number; w: number; h: number }): string[]
    rect(id: string): { x: number; y: number; w: number; h: number } | undefined
  }
  doc: {
    elements(): Iterable<{ id: string; kind: string; parentId: string | null }>
    mutable(id: string): { set(k: string, v: unknown): void } | undefined
    ydoc: { transact(fn: () => void): void }
  }
  selectAll(): void
  copy(): unknown
  paste(data: unknown): void
  zoomToFit(ids?: Iterable<string>): void
  zoomTo(z: number): void
  worldToClient(x: number, y: number): { x: number; y: number }
}
/** e2e 构建暴露的入口（见 e2e/canvas.ts），这里按基准需要的部分另行声明 */
type PerfWindow = {
  __plein?: { engine: Engine }
  __perf?: { frames: number[]; long: number; mutations: number; stop(): void }
}

async function startServer() {
  // 端口上已有服务（上次中断残留）会让结果测到旧构建
  const stale = await fetch(`${BASE}/api/health`).catch(() => null)
  if (stale) throw new Error(`端口 ${PORT} 已被占用，先停掉残留的服务`)
  const dataDir = mkdtempSync(join(tmpdir(), 'plein-perf-'))
  const proc = spawn(
    join(ROOT, 'apps/server/node_modules/.bin/tsx'),
    [join(ROOT, 'apps/server/src/main.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PLEIN_PORT: String(PORT),
        PLEIN_DATA_DIR: dataDir,
        PLEIN_WEB_DIST: WEB_DIST,
        PLEIN_MOCK_PROVIDER: '1',
        PLEIN_AGENT: '0',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
      // 单独的进程组：结束时连同 tsx 拉起的子进程一起停掉；不触发包管理器同步依赖。
      detached: true,
    },
  )
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return { proc, dataDir }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  await stopServer(proc, dataDir)
  throw new Error('服务没有起来')
}

async function stopServer(proc: ChildProcess, dataDir: string) {
  const stopped = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {}
      resolve()
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  try {
    process.kill(-proc.pid!, 'SIGTERM')
  } catch {}
  await stopped
  rmSync(dataDir, { recursive: true, force: true })
}

const METRICS = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration'] as const
type Metrics = Record<(typeof METRICS)[number], number>

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const out = {} as Metrics
  for (const k of METRICS) out[k] = (metrics.find((m) => m.name === k)?.value ?? 0) * 1000
  return out
}

/** 页内记录：每帧时间戳、长任务、覆盖层 DOM 变动 */
async function startProbe(page: Page) {
  await page.evaluate(() => {
    const frames: number[] = []
    let on = true
    const tick = (t: number) => {
      if (!on) return
      frames.push(t)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const probe = { frames, long: 0, mutations: 0, stop: () => {} }
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) probe.long += e.duration
    })
    po.observe({ type: 'longtask' })
    const mo = new MutationObserver((records) => {
      probe.mutations += records.length
    })
    mo.observe(document.body, { subtree: true, childList: true, attributes: true })
    probe.stop = () => {
      on = false
      po.disconnect()
      mo.disconnect()
    }
    ;(window as unknown as PerfWindow).__perf = probe
  })
}

async function stopProbe(page: Page) {
  return page.evaluate(() => {
    const p = (window as unknown as PerfWindow).__perf!
    p.stop()
    return {
      frames: p.frames.length,
      long: p.long,
      mutations: p.mutations,
    }
  })
}

interface Result {
  frames: number
  /** 每帧 JS 自身耗时（ms，CPU 采样，不含原生调用） */
  js: number
  /** 每帧原生耗时（ms）：主要是软件光栅的 WebGL，真机上走 GPU，仅供参考 */
  native: number
  /** 每帧布局 / 样式重算耗时（ms） */
  layout: number
  style: number
  /** 长任务总时长（ms） */
  long: number
  /** 每帧 DOM 变动条数 */
  mutations: number
}

type Profile = Awaited<ReturnType<typeof stopProfile>>

async function startProfile(cdp: CDPSession) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
}

/** 按函数汇总自耗时（ms） */
async function stopProfile(cdp: CDPSession) {
  const { profile } = await cdp.send('Profiler.stop')
  const dt = new Map<number, number>()
  profile.samples!.forEach((id, i) => {
    dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas![i] ?? 0))
  })
  const self = new Map<string, number>()
  for (const n of profile.nodes) {
    const f = n.callFrame
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`
    self.set(key, (self.get(key) ?? 0) + (dt.get(n.id) ?? 0) / 1000)
  }
  let js = 0
  for (const [k, v] of self) if (!k.startsWith('(program)') && !k.startsWith('(idle)')) js += v
  return { self, js, native: self.get('(program) :-1') ?? 0 }
}

function printTop(self: Map<string, number>) {
  const total = [...self.values()].reduce((t, v) => t + v, 0)
  console.log(`总采样 ${total.toFixed(0)} ms`)
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30))
    console.log(`${v.toFixed(1).padStart(8)} ms  ${k}`)
}

async function measure(page: Page, cdp: CDPSession, run: () => Promise<void>): Promise<Result> {
  await page.waitForTimeout(300)
  const before = await metrics(cdp)
  await startProbe(page)
  await startProfile(cdp)
  await run()
  const prof: Profile = await stopProfile(cdp)
  const probe = await stopProbe(page)
  const after = await metrics(cdp)
  const f = Math.max(1, probe.frames)
  return {
    frames: probe.frames,
    js: prof.js / f,
    native: prof.native / f,
    layout: (after.LayoutDuration - before.LayoutDuration) / f,
    style: (after.RecalcStyleDuration - before.RecalcStyleDuration) / f,
    long: probe.long,
    mutations: probe.mutations / f,
  }
}

function median(rs: Result[]): Result {
  const pick = (k: keyof Result) => {
    const v = rs.map((r) => r[k]).sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]!
  }
  return {
    frames: pick('frames'),
    js: pick('js'),
    native: pick('native'),
    layout: pick('layout'),
    style: pick('style'),
    long: pick('long'),
    mutations: pick('mutations'),
  }
}

/** 页内连续派发滚轮事件：每帧 perFrame 个，模拟高频触控板 */
function wheel(page: Page, opts: { frames: number; perFrame: number; zoom: boolean }) {
  return page.evaluate(
    ({ frames, perFrame, zoom }) =>
      new Promise<void>((done) => {
        const host = document.querySelector('canvas')!.parentElement!
        const r = host.getBoundingClientRect()
        let i = 0
        const step = () => {
          for (let k = 0; k < perFrame; k++) {
            const phase = Math.sin((i / frames) * Math.PI * 2)
            host.dispatchEvent(
              new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: r.left + r.width / 2,
                clientY: r.top + r.height / 2,
                deltaX: zoom ? 0 : 6 * phase,
                deltaY: zoom ? 3 * phase : 4,
                ctrlKey: zoom,
              }),
            )
          }
          if (++i < frames) requestAnimationFrame(step)
          else requestAnimationFrame(() => done())
        }
        requestAnimationFrame(step)
      }),
    opts,
  )
}

async function engineReady(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as PerfWindow).__plein?.engine, null, {
    timeout: 60_000,
  })
}

/** 选中视口中央附近一个某种类型的元素，返回它的屏幕中心 */
async function pickVisible(page: Page, kind: string | null, count = 1) {
  return page.evaluate(
    ({ kind, count }) => {
      const e = (window as unknown as PerfWindow).__plein!.engine
      const v = e.camera.viewRect
      const inner = { x: v.x + v.w * 0.3, y: v.y + v.h * 0.3, w: v.w * 0.4, h: v.h * 0.4 }
      const els = new Map([...e.doc.elements()].map((el) => [el.id, el]))
      return e.scene
        .query(inner)
        .filter((id) => {
          const el = els.get(id)
          return !!el && !el.parentId && el.kind !== 'frame' && (kind === null || el.kind === kind)
        })
        .slice(0, count)
    },
    { kind, count },
  )
}

type Scenario = (page: Page) => Promise<void>

async function main() {
  if (!Number.isSafeInteger(N) || N < 1 || !Number.isSafeInteger(ROUNDS) || ROUNDS < 1)
    throw new Error('PERF_N and PERF_ROUNDS must be positive integers')
  const renderMode = process.env.PERF_RENDERER ?? 'software'
  if (!['software', 'hardware'].includes(renderMode))
    throw new Error('PERF_RENDERER must be software or hardware')
  const fingerprint = buildFingerprint()
  failureContext.buildFingerprint = fingerprint
  const { proc, dataDir } = await startServer()
  const cleanup = () => {
    void stopServer(proc, dataDir)
  }
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  let browser: Browser | undefined
  const viewport = { width: 1440, height: 900 }
  let browserVersion = ''
  let renderer = 'unobserved'
  const report: Record<string, Result | number> = {}
  const openSamples: { cold: OpenSample[]; warm: OpenSample[] } = { cold: [], warm: [] }
  let fixture: PerfReport['fixture'] = {
    version: MEDIA_FIXTURE_VERSION,
    elements: N,
    imageAssets: 0,
    videoAssets: 0,
    audioAssets: 0,
    serializedBytes: 0,
  }
  failureContext.fixture = fixture
  failureContext.details = { openSamples, interactions: report }
  const observeRenderer = (page: Page) =>
    page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const gl = canvas?.getContext('webgl2')
      if (!gl) throw new Error('Performance fixture requires a WebGL2 canvas')
      const debug = gl.getExtension('WEBGL_debug_renderer_info')
      return String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))
    })
  try {
    browser = await chromium.launch({
      executablePath: process.env.PERF_CHROMIUM,
      args:
        renderMode === 'software'
          ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
          : [],
    })
    browserVersion = browser.version()
    Object.assign(failureContext.environment as object, { browserVersion, viewport })
    const ctx = await browser.newContext({ viewport })
    await installFunctionSerialization(ctx)
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Performance.enable')

    // ── 打开画布 ──────────────────────────────────────
    const profileWarm = process.env.PERF_PROFILE === '热开'
    const profileOpen = process.env.PERF_PROFILE === '打开' || profileWarm
    if ((!process.env.PERF_PROFILE || profileOpen) && !process.env.PERF_SKIP_OPEN) {
      const media = await createMediaFixture(BASE, {
        elements: N,
        imageAssets: Number(process.env.PERF_MEDIA_ASSETS ?? 32),
      })
      const { data: _data, ...metadata } = media
      fixture = metadata
      failureContext.fixture = fixture
      const canvasId = await seedMediaCanvas(page, BASE, media)
      renderer = await observeRenderer(page)
      Object.assign(failureContext.environment as object, { renderer })
      assertRendererMode(renderMode, renderer)
      await page.goto(`${BASE}/#/`)
      for (let i = 0; i < ROUNDS; i++) {
        // 冷开：全新的浏览器上下文（没有任何本地缓存）
        const cold = await browser.newContext({ viewport })
        await installFunctionSerialization(cold)
        const p = await cold.newPage()
        const pcdp = profileOpen ? await cold.newCDPSession(p) : null
        const network = watchAssetRequests(p)
        try {
          await installOpenProbe(p, N)
          if (pcdp && !profileWarm) await startProfile(pcdp)
          await p.goto(`${BASE}/#/c/${canvasId}`)
          openSamples.cold.push(await readOpenSample(p, network.requests))
          console.error(`[perf] cold ${i + 1}/${ROUNDS}`, JSON.stringify(openSamples.cold.at(-1)))
          network.stop()
          if (pcdp && !profileWarm) {
            const { self } = await stopProfile(pcdp)
            console.log(`冷开首个预览 ${openSamples.cold[0]!.firstVisiblePreviewMs.toFixed(0)} ms`)
            printTop(self)
            return
          }
          // Warm route: reuse the browser's HTTP/IndexedDB caches after releasing the old engine.
          await p.evaluate(() => {
            location.hash = '#/'
          })
          await p.waitForFunction(() => !(window as unknown as PerfWindow).__plein)
          const warmNetwork = watchAssetRequests(p)
          try {
            await resetOpenProbe(p, N)
            if (pcdp && profileWarm) await startProfile(pcdp)
            await p.evaluate((id) => {
              location.hash = `#/c/${id}`
            }, canvasId)
            openSamples.warm.push(await readOpenSample(p, warmNetwork.requests))
            console.error(`[perf] warm ${i + 1}/${ROUNDS}`, JSON.stringify(openSamples.warm.at(-1)))
            if (pcdp && profileWarm) {
              const { self } = await stopProfile(pcdp)
              console.log(
                `热开首个预览 ${openSamples.warm[0]!.firstVisiblePreviewMs.toFixed(0)} ms`,
              )
              printTop(self)
              return
            }
          } finally {
            warmNetwork.stop()
          }
        } finally {
          network.stop()
          await cold.close()
        }
      }
      for (const mode of ['cold', 'warm'] as const) {
        for (const key of [
          'engineReadyMs',
          'firstVisiblePreviewMs',
          'visibleMediaSettledMs',
        ] as const) {
          const values = openSamples[mode].map((sample) => sample[key]).sort((a, b) => a - b)
          report[`${mode}.${key}`] = values[Math.floor(values.length / 2)]!
        }
      }
      console.error('[perf] 真实媒体冷开/热开', JSON.stringify(report))
    }

    // ── 交互场景（演示画布，纯前端）────────────────────
    const scenarios: Record<string, Scenario> = {
      平移: (p) => wheel(p, { frames: 120, perFrame: 2, zoom: false }),
      缩放: (p) => wheel(p, { frames: 120, perFrame: 2, zoom: true }),
      '平移（选中素材，浮动工具条跟随）': async (p) => {
        const [id] = await pickVisible(p, 'image')
        await p.evaluate(
          (id) => (window as unknown as PerfWindow).__plein!.engine.selection.set([id!]),
          id,
        )
        await p.waitForTimeout(200)
        await wheel(p, { frames: 120, perFrame: 2, zoom: false })
      },
      '拖动 12 个元素': async (p) => {
        // 散落区里文档顺序相邻的 12 个元素（同一行），先把镜头对准它们
        const at = await p.evaluate(async () => {
          const e = (window as unknown as PerfWindow).__plein!.engine
          const ids = [...e.doc.elements()]
            .filter((el) => !el.parentId && el.kind !== 'frame')
            .slice(0, 12)
            .map((el) => el.id)
          e.zoomToFit(ids)
          e.selection.set(ids)
          await new Promise((r) => setTimeout(r, 300))
          const r = e.scene.rect(ids[0]!)!
          return e.worldToClient(r.x + r.w / 2, r.y + r.h / 2)
        })
        await p.mouse.move(at.x, at.y)
        await p.mouse.down()
        for (let i = 1; i <= 90; i++) {
          await p.mouse.move(at.x + Math.sin(i / 10) * 200, at.y + i)
        }
        await p.mouse.up()
        await p.keyboard.press('Control+z')
      },
      '静止（20 个节点生成中）': async (p) => {
        await p.evaluate(() => {
          const e = (window as unknown as PerfWindow).__plein!.engine
          const nodes = [...e.doc.elements()].filter((el) => el.kind === 'node').slice(0, 20)
          e.doc.ydoc.transact(() => {
            for (const n of nodes)
              e.doc.mutable(n.id)!.set('run', { status: 'running', progress: 0.3 })
          })
        })
        await p.waitForTimeout(2000)
      },
    }

    // PERF_PROFILE=<场景名>：只跑这一个场景一轮，打印 CPU 自耗时最多的函数
    const only = process.env.PERF_PROFILE
    if (only) {
      await page.goto(`${BASE}/#/demo?n=${N}`)
      await engineReady(page)
      await page.evaluate(() => (window as unknown as PerfWindow).__plein!.engine.zoomTo(1))
      await page.waitForTimeout(500)
      await startProfile(cdp)
      await scenarios[only]!(page)
      const { self } = await stopProfile(cdp)
      printTop(self)
      return
    }

    // PERF_SCENARIOS=平移,缩放：只跑这几个
    const pick = process.env.PERF_SCENARIOS?.split(',')
    for (const [name, run] of Object.entries(scenarios)) {
      if (pick && !pick.includes(name)) continue
      const rs: Result[] = []
      for (let i = 0; i < ROUNDS; i++) {
        await page.goto(`${BASE}/#/`)
        await page.goto(`${BASE}/#/demo?n=${N}`)
        await engineReady(page)
        if (renderer === 'unobserved') renderer = await observeRenderer(page)
        Object.assign(failureContext.environment as object, { renderer })
        assertRendererMode(renderMode, renderer)
        await page.evaluate(() => (window as unknown as PerfWindow).__plein!.engine.zoomTo(1))
        await page.waitForTimeout(500)
        rs.push(await measure(page, cdp, () => run(page)))
        console.error(`[perf] ${name} 第 ${i + 1} 轮`, JSON.stringify(rs.at(-1)))
      }
      report[name] = median(rs)
    }
  } finally {
    try {
      await browser?.close()
    } finally {
      await stopServer(proc, dataDir)
      process.off('SIGINT', cleanup)
      process.off('SIGTERM', cleanup)
    }
  }

  if (buildFingerprint() !== fingerprint)
    throw new Error(
      'Frontend build changed during measurement; discard this run and repeat against a frozen build',
    )

  assertRendererMode(renderMode, renderer)

  console.log(`\n元素数 ${N}，每项 ${ROUNDS} 轮取中位数`)
  for (const [k, v] of Object.entries(report)) {
    if (typeof v === 'number') console.log(`${k}: ${v}`)
    else
      console.log(
        `${k}: 帧 ${v.frames}，每帧 JS ${v.js.toFixed(2)} / 布局 ${v.layout.toFixed(2)} / 样式 ${v.style.toFixed(2)} ms，` +
          `原生调用 ${v.native.toFixed(1)} ms，长任务 ${v.long.toFixed(0)} ms，DOM 变动 ${v.mutations.toFixed(1)}/帧`,
      )
  }
  const metrics: Record<string, number> = {}
  for (const [name, result] of Object.entries(report)) {
    if (typeof result === 'number') metrics[name] = result
    else metrics[`${name}.jsMs`] = result.js
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  const output: PerfReport = {
    formatVersion: 1,
    status: 'complete',
    buildFingerprint: fingerprint,
    sourceCommit: git('rev-parse', 'HEAD'),
    sourceDirty: !!git('status', '--porcelain'),
    measuredAt: new Date().toISOString(),
    environment: {
      runtime: `node ${process.versions.node}`,
      platform: `${process.platform}/${process.arch}`,
      browserVersion,
      renderer,
      renderMode,
      viewport,
    },
    fixture,
    rounds: ROUNDS,
    metrics,
    details: { openSamples, interactions: report },
  }
  Object.assign(failureContext, output)
  const baseline = process.env.PERF_BASELINE
  const regressions = baseline
    ? comparePerfReports(output, JSON.parse(readFileSync(baseline, 'utf8')) as PerfReport)
    : []
  const complete = { ...output, baselineCompared: !!baseline, regressions }
  const json = JSON.stringify(complete, null, 2)
  writeReport(complete)
  if (process.env.PERF_JSON) console.log(json)
  if (regressions.length) {
    console.error('Performance regression:', JSON.stringify(regressions))
    process.exitCode = 1
  }
}

await main().catch((error: unknown) => {
  const failure = {
    ...failureContext,
    formatVersion: 1,
    status: 'failed',
    measuredAt: new Date().toISOString(),
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { message: String(error) },
  }
  writeReport(failure)
  console.error(error)
  if (process.env.PERF_JSON) console.log(JSON.stringify(failure, null, 2))
  process.exitCode = 1
})
