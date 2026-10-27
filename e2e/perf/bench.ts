/**
 * 渲染性能基准：真服务 + e2e 构建的前端，在无头 Chromium 里驱动画布并读 CDP 指标。
 *
 *   pnpm perf            # 先构建 apps/web/dist-e2e，再跑全部场景（约 10 分钟）
 *   PERF_N=3000 pnpm perf
 *   PERF_RENDERER=hardware pnpm perf  # 显式使用完整 Chromium，并校验实际 GPU
 *   PERF_PROFILE=会话 PERF_SESSION_MS=600000 pnpm perf  # 十分钟诊断，不作完整门禁报告
 *   PERF_OPEN_ONLY=1 pnpm perf  # 只重复打开，诊断报告不会被 perf:compare 接受
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
import type { CanvasElement, Edge } from '../../packages/doc/src/types'
import {
  createMediaFixture,
  fixtureContentHash,
  MEDIA_FIXTURE_VERSION,
  normalizeDemoFixture,
  seedMediaCanvas,
} from './fixtures'
import {
  installFunctionSerialization,
  installOpenProbe,
  type OpenSample,
  readOpenSample,
  resetOpenProbe,
  watchAssetRequests,
} from './probe'
import {
  assertCompletePerfReport,
  assertRendererMode,
  comparePerfReports,
  medianSample,
  PERF_FORMAT_VERSION,
  type PerfReport,
} from './report'
import { measureMarkdownRetention, measureSession } from './memory'

/** 被测的仓库根目录：服务端和前端构建都从这里取；对比改动前后时指向另一个检出 */
const ROOT = process.env.PERF_ROOT ?? join(import.meta.dirname, '../..')
const PORT = Number(process.env.PERF_PORT ?? 9510)
const BASE = `http://127.0.0.1:${PORT}`
const N = Number(process.env.PERF_N ?? 1000)
/** 每个场景跑几轮取中位数 */
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 3)
const SESSION_MS = Number(process.env.PERF_SESSION_MS ?? 30_000)
const SESSION_ITERATIONS = Number(process.env.PERF_SESSION_ITERATIONS ?? 12)
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
    elements(): Iterable<CanvasElement>
    edges(): Iterable<Edge>
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

function logOpen(mode: string, round: number, sample: OpenSample) {
  const { resources, ...summary } = sample
  console.error(
    `[perf] ${mode} ${round}/${ROUNDS}`,
    JSON.stringify({ ...summary, resources: resources.length }),
  )
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
  return deadline(
    page,
    page.evaluate(
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
    ),
  )
}

/** rAF 在页面挂起时可能永不继续，超时关闭自己的页面并让基准失败。 */
async function deadline<T>(page: Page, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Performance interaction timed out after 60 seconds'))
          void page.close().catch(() => {})
        }, 60_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function engineReady(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as PerfWindow).__plein?.engine, null, {
    timeout: 60_000,
  })
}

async function openFixture(page: Page, url: string, elements: number) {
  await page.goto(`${BASE}/#/`)
  await page.waitForFunction(() => !(window as unknown as PerfWindow).__plein)
  await page.goto(url)
  await page.waitForFunction((expected) => {
    const engine = (window as unknown as PerfWindow).__plein?.engine
    return !!engine && [...engine.doc.elements()].length === expected
  }, elements)
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

async function sessionInteraction(page: Page) {
  await wheel(page, { frames: 60, perFrame: 2, zoom: false })
  await wheel(page, { frames: 60, perFrame: 2, zoom: true })
  // 每个采样点回到同一视口，不能拿离屏剔除后的堆与全画布相减。
  await page.evaluate(() => (window as unknown as PerfWindow).__plein!.engine.zoomToFit())
  await page.waitForTimeout(300)
}

async function main() {
  const startedAt = performance.now()
  if (!Number.isSafeInteger(N) || N < 1 || !Number.isSafeInteger(ROUNDS) || ROUNDS < 1)
    throw new Error('PERF_N and PERF_ROUNDS must be positive integers')
  if (!Number.isSafeInteger(SESSION_MS) || SESSION_MS < 1000)
    throw new Error('PERF_SESSION_MS must be an integer of at least 1000 ms')
  if (!Number.isSafeInteger(SESSION_ITERATIONS) || SESSION_ITERATIONS < 1)
    throw new Error('PERF_SESSION_ITERATIONS must be a positive integer')
  const load = () => ({
    at: new Date().toISOString(),
    uptime: execFileSync('uptime', { encoding: 'utf8' }).trim(),
  })
  const hostLoad = [load()]
  console.error('[perf] host load', JSON.stringify(hostLoad[0]))
  const renderMode = process.env.PERF_RENDERER ?? 'software'
  const browserExecutable =
    process.env.PERF_CHROMIUM ?? (renderMode === 'hardware' ? chromium.executablePath() : undefined)
  const browserKind =
    browserExecutable && !/headless[-_]shell/i.test(browserExecutable)
      ? 'chromium'
      : 'headless-shell'
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
  const samples: Record<string, number[]> = {}
  const interactionSamples: Record<string, Result[]> = {}
  const openSamples: { cold: OpenSample[]; warm: OpenSample[] } = { cold: [], warm: [] }
  let mediaCanvasId: string | undefined
  const details = {
    durationMs: 0,
    hostLoad,
    browserExecutable: browserExecutable ?? 'playwright headless shell',
    memory: [] as Array<{
      markdown: Awaited<ReturnType<typeof measureMarkdownRetention>>
      session: Awaited<ReturnType<typeof measureSession>>
    }>,
    openSamples,
    interactions: report,
    interactionSamples,
    demoFixture: null as ReturnType<typeof normalizeDemoFixture> | null,
  }
  let fixture: PerfReport['fixture'] = {
    version: MEDIA_FIXTURE_VERSION,
    elements: N,
    imageAssets: 0,
    videoAssets: 0,
    audioAssets: 0,
    serializedBytes: 0,
    contentHash: '',
    demoContentHash: '',
    sessionIterations: SESSION_ITERATIONS,
  }
  failureContext.fixture = fixture
  failureContext.samples = samples
  failureContext.details = details
  const diagnostic = (extra: Record<string, unknown>) => {
    if (buildFingerprint() !== fingerprint)
      throw new Error('Frontend build changed during measurement')
    hostLoad.push(load())
    details.durationMs = performance.now() - startedAt
    writeReport({
      ...failureContext,
      status: 'diagnostic',
      measuredAt: new Date().toISOString(),
      ...extra,
    })
  }
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
      // Playwright 默认的 headless shell 可能静默退回软件光栅；硬件模式明确用完整 Chromium。
      executablePath: browserExecutable,
      args:
        renderMode === 'software'
          ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
          : [],
    })
    browserVersion = browser.version()
    Object.assign(failureContext.environment as object, { browserVersion, browserKind, viewport })
    const ctx = await browser.newContext({ viewport })
    await installFunctionSerialization(ctx)
    const page = await ctx.newPage()
    page.setDefaultTimeout(60_000)
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Performance.enable')

    // ── 打开画布 ──────────────────────────────────────
    const profileWarm = process.env.PERF_PROFILE === '热开'
    const profileSession = process.env.PERF_PROFILE === '会话'
    const profileOpen = process.env.PERF_PROFILE === '打开' || profileWarm
    if (
      (!process.env.PERF_PROFILE || profileOpen || profileSession) &&
      !process.env.PERF_SKIP_OPEN
    ) {
      const media = await createMediaFixture(BASE, {
        elements: N,
        imageAssets: Number(process.env.PERF_MEDIA_ASSETS ?? 32),
      })
      const { data: _data, ...metadata } = media
      fixture = { ...metadata, demoContentHash: '', sessionIterations: SESSION_ITERATIONS }
      failureContext.fixture = fixture
      const canvasId = await seedMediaCanvas(page, BASE, media)
      mediaCanvasId = canvasId
      renderer = await observeRenderer(page)
      Object.assign(failureContext.environment as object, { renderer })
      assertRendererMode(renderMode, renderer)
      if (profileSession) {
        const session = await measureSession(page, cdp, SESSION_MS, () => sessionInteraction(page))
        diagnostic({ session, hostLoad })
        console.log(
          '[perf] sustained session',
          JSON.stringify({
            durationMs: session.samples.at(-1)!.elapsedMs,
            retainedBytes: session.retainedBytes,
            tailBytes: session.tailBytes,
            hostLoad,
          }),
        )
        return
      }
      await page.goto(`${BASE}/#/`)
      for (let i = 0; i < ROUNDS; i++) {
        // 冷开：全新的浏览器上下文（没有任何本地缓存）
        const cold = await browser.newContext({ viewport })
        await installFunctionSerialization(cold)
        const p = await cold.newPage()
        p.setDefaultTimeout(60_000)
        const pcdp = profileOpen ? await cold.newCDPSession(p) : null
        const network = watchAssetRequests(p)
        try {
          await installOpenProbe(p, N)
          if (pcdp && !profileWarm) await startProfile(pcdp)
          await p.goto(`${BASE}/#/c/${canvasId}`)
          openSamples.cold.push(await readOpenSample(p, network.requests))
          logOpen('cold', i + 1, openSamples.cold.at(-1)!)
          network.stop()
          if (pcdp && !profileWarm) {
            const { self } = await stopProfile(pcdp)
            console.log(`冷开首个预览 ${openSamples.cold[0]!.firstVisiblePreviewMs.toFixed(0)} ms`)
            printTop(self)
            diagnostic({ profile: [...self], mode: 'cold' })
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
            logOpen('warm', i + 1, openSamples.warm.at(-1)!)
            if (pcdp && profileWarm) {
              const { self } = await stopProfile(pcdp)
              console.log(
                `热开首个预览 ${openSamples.warm[0]!.firstVisiblePreviewMs.toFixed(0)} ms`,
              )
              printTop(self)
              diagnostic({ profile: [...self], mode: 'warm' })
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
          const metric = `${mode}.${key}`
          samples[metric] = openSamples[mode].map((sample) => sample[key])
          report[metric] = medianSample(samples[metric])
        }
      }
      console.error('[perf] 真实媒体冷开/热开', JSON.stringify(report))
      if (process.env.PERF_OPEN_ONLY) {
        diagnostic({ metrics: report })
        return
      }
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
          if (ids.length !== 12) throw new Error('Drag scenario requires exactly 12 elements')
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
          if (nodes.length !== 20) throw new Error('Running scenario requires exactly 20 nodes')
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
      interactionSamples[name] = rs
      for (let i = 0; i < ROUNDS; i++) {
        await openFixture(page, `${BASE}/#/demo?n=${N}`, N)
        if (renderer === 'unobserved') renderer = await observeRenderer(page)
        Object.assign(failureContext.environment as object, { renderer })
        assertRendererMode(renderMode, renderer)
        await page.evaluate(() => (window as unknown as PerfWindow).__plein!.engine.zoomTo(1))
        await page.waitForTimeout(500)
        const snapshot = await page.evaluate(() => {
          const doc = (window as unknown as PerfWindow).__plein!.engine.doc
          return { elements: [...doc.elements()], edges: [...doc.edges()] }
        })
        const normalized = normalizeDemoFixture(snapshot)
        const contentHash = fixtureContentHash(normalized)
        if (!details.demoFixture) details.demoFixture = normalized
        if (fixture.demoContentHash && fixture.demoContentHash !== contentHash) {
          failureContext.demoFixtureMismatch = {
            scenario: name,
            round: i + 1,
            expectedHash: fixture.demoContentHash,
            actualHash: contentHash,
            actualFixture: normalized,
          }
          throw new Error(`Demo fixture changed between performance samples: ${name}`)
        }
        fixture.demoContentHash = contentHash
        rs.push(await measure(page, cdp, () => run(page)))
        console.error(`[perf] ${name} 第 ${i + 1} 轮`, JSON.stringify(rs.at(-1)))
      }
      report[name] = median(rs)
      samples[`${name}.jsMs`] = rs.map((sample) => sample.js)
    }

    if (!process.env.PERF_SKIP_MEMORY) {
      for (let i = 0; i < ROUNDS; i++) {
        await openFixture(page, `${BASE}/#/demo?n=0`, 0)
        const markdown = await deadline(page, measureMarkdownRetention(page, cdp))
        await openFixture(
          page,
          mediaCanvasId ? `${BASE}/#/c/${mediaCanvasId}` : `${BASE}/#/demo?n=${N}`,
          N,
        )
        await page.evaluate(() => (window as unknown as PerfWindow).__plein!.engine.zoomToFit())
        const session = await measureSession(
          page,
          cdp,
          SESSION_MS,
          () => sessionInteraction(page),
          SESSION_ITERATIONS,
        )
        details.memory.push({ markdown, session })
        hostLoad.push(load())
        console.error(
          `[perf] memory ${i + 1}/${ROUNDS}`,
          JSON.stringify({
            markdownRetainedBytes: markdown.retainedBytes,
            sessionRetainedBytes: session.retainedBytes,
            sessionTailBytes: session.tailBytes,
            hostLoad: hostLoad.at(-1),
          }),
        )
      }
      for (const kind of ['markdown', 'session'] as const) {
        const metric = `${kind}.retainedBytes`
        samples[metric] = details.memory.map((sample) => sample[kind].retainedBytes)
        report[metric] = medianSample(samples[metric])
      }
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

  hostLoad.push(load())
  details.durationMs = performance.now() - startedAt

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
    formatVersion: PERF_FORMAT_VERSION,
    status: 'complete',
    buildFingerprint: fingerprint,
    sourceCommit: git('rev-parse', 'HEAD'),
    sourceDirty: !!git('status', '--porcelain'),
    measuredAt: new Date().toISOString(),
    environment: {
      runtime: `node ${process.versions.node}`,
      platform: `${process.platform}/${process.arch}`,
      browserVersion,
      browserKind,
      renderer,
      renderMode,
      viewport,
    },
    fixture,
    rounds: ROUNDS,
    metrics,
    samples,
    details,
  }
  Object.assign(failureContext, output)
  assertCompletePerfReport(output)
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
    formatVersion: PERF_FORMAT_VERSION,
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
