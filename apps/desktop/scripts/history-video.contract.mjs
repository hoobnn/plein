/**
 * 本机 Electron 视频审片合同：真实 H.264/AAC 播放后，父级「生成历史」必须能用 × 关闭。
 * 只使用 e2e 构建、临时 userData 和临时服务数据，不读取正式数据目录或安装包。
 * 先构建 apps/web/dist-e2e 与 apps/desktop/dist；可用 pnpm --filter @plein/desktop test:history-video。
 * 可选 PLEIN_NATIVE_HISTORY_REPORT=<绝对路径> 保存包含命中、事件与媒体状态的 JSON 证据。
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '../../..')
const marker = 'PLEIN_HISTORY_VIDEO_CONTRACT_MAIN'
const cases = [
  { action: 'autoplay', viewerExit: 'x' },
  { action: 'manual', viewerExit: 'x' },
  { action: 'seek', viewerExit: 'x' },
  { action: 'ended', viewerExit: 'x' },
  { action: 'seek', viewerExit: 'backdrop' },
  { action: 'autoplay', viewerExit: 'escape' },
]

if (process.env[marker] === '1' && process.versions.electron) void runElectron()
else void runContract()

async function runElectron() {
  const { app, BrowserWindow } = await import('electron')
  const dist = process.env.PLEIN_NATIVE_HISTORY_DIST
  const scratch = process.env.PLEIN_HISTORY_VIDEO_SCRATCH
  if (!dist || !isAbsolute(dist) || !scratch) throw new Error('缺少隔离合同启动参数')
  app.setName('Plein History Video Contract')
  mkdirSync(join(scratch, 'electron'), { recursive: true })
  app.setPath('userData', join(scratch, 'electron'))
  app.on('window-all-closed', () => {})
  let server
  let exited
  let stopping = false
  app.on('before-quit', (event) => {
    if (!server || server.exitCode !== null || stopping) return
    event.preventDefault()
    stopping = true
    server.kill('SIGTERM')
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
    void exited.then(() => {
      clearTimeout(timer)
      app.quit()
    })
  })
  await app.whenReady()
  server = spawn(
    process.env.PLEIN_NATIVE_HISTORY_NODE ?? 'node',
    [
      '--import',
      join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'),
      join(root, 'apps/server/src/main.ts'),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PLEIN_HOST: '127.0.0.1',
        PLEIN_PORT: '0',
        PLEIN_DATA_DIR: join(scratch, 'data'),
        PLEIN_WEB_DIST: dist,
        PLEIN_MOCK_PROVIDER: '1',
        PLEIN_AGENT: '0',
        PLEIN_AUTH: 'none',
        PLEIN_DESKTOP_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  exited = new Promise((done) => server.once('close', done))
  let serverLog = ''
  const base = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('隔离服务启动超时')), 15000)
    const inspect = (data) => {
      serverLog += data.toString()
      const match = serverLog.match(/plein 已启动：(http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        clearTimeout(timer)
        done(match[1])
      }
    }
    server.stdout.on('data', inspect)
    server.stderr.on('data', inspect)
    server.once('error', fail)
    server.once('close', () => fail(new Error(`隔离服务提前退出：${serverLog}`)))
  })
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 27 },
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: join(root, 'apps/desktop/dist/preload.cjs'),
    },
  })
  await win.loadURL(base)
}

async function runContract() {
  const { _electron, expect } = await import('@playwright/test')
  const dist = process.env.PLEIN_NATIVE_HISTORY_DIST ?? join(root, 'apps/web/dist-e2e')
  if (!isAbsolute(dist)) throw new Error('PLEIN_NATIVE_HISTORY_DIST 必须是绝对路径')
  const scratch = mkdtempSync(join(tmpdir(), 'plein-history-video-'))
  const clip = join(scratch, 'clip.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30:duration=8',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=8',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    '-shortest',
    clip,
  ])
  const data = readFileSync(clip)
  const report = {
    electron: '',
    buildFingerprint: createHash('sha256')
      .update(readFileSync(join(dist, 'index.html')))
      .digest('hex'),
    cases: [],
    passed: false,
  }
  try {
    for (const item of cases) {
      const record = { ...item, passed: false }
      report.cases.push(record)
      try {
        await runCase({ item, record, data, dist, scratch, expect, _electron, report })
        record.passed = true
      } catch (error) {
        record.error = String(error.stack ?? error)
        throw error
      } finally {
        console.log(JSON.stringify(record))
      }
    }
    report.passed =
      report.cases.length === cases.length && report.cases.every((item) => item.passed)
  } catch (error) {
    report.error = String(error.stack ?? error)
    process.exitCode = 1
  } finally {
    if (process.env.PLEIN_NATIVE_HISTORY_REPORT)
      writeFileSync(process.env.PLEIN_NATIVE_HISTORY_REPORT, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length }))
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function runCase({ item, record, data, dist, scratch, expect, _electron, report }) {
  const { action, viewerExit } = item
  const require = createRequire(join(root, 'apps/desktop/package.json'))
  const caseScratch = join(scratch, `${action}-${viewerExit}`)
  mkdirSync(caseScratch, { recursive: true })
  let electron
  try {
    electron = await _electron.launch({
      executablePath: require('electron'),
      args: [script],
      env: {
        ...process.env,
        [marker]: '1',
        PLEIN_NATIVE_HISTORY_DIST: dist,
        PLEIN_HISTORY_VIDEO_SCRATCH: caseScratch,
      },
    })
    report.electron = await electron.evaluate(() => process.versions.electron)
    const page = await electron.firstWindow()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await electron.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.show()
      win?.focus()
    })
    await page.bringToFront()
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await page.waitForFunction(() => !!window.__plein)
    const upload = await page.context().request.post(`${new URL(page.url()).origin}/api/assets`, {
      headers: { 'content-type': 'video/mp4', 'x-file-name': 'history.mp4' },
      data,
    })
    expect(upload.status()).toBe(201)
    const assetId = (await upload.json()).id
    await page.evaluate((assetId) => {
      const id = window.__plein.addNode({
        type: 'plein/video',
        name: '历史视频',
        params: { prompt: '测试视频' },
        x: 300,
        y: 200,
      })
      window.__plein.engine.doc.mutable(id).set('results', [
        {
          id: 'video-result',
          runId: 'fixture-run',
          port: 'video',
          value: { type: 'video', assetId },
          at: Date.now(),
        },
      ])
    }, assetId)
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '生成历史' })
    await history.getByRole('button', { name: '预览「历史视频」' }).click()
    const viewer = page.getByRole('dialog', { name: '查看「历史视频」' })
    const video = viewer.locator('video')
    await expect(video).toBeVisible()
    await expect.poll(() => video.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(2)
    await expect.poll(() => video.evaluate((el) => el.currentTime)).toBeGreaterThan(0)
    const videoBox = await video.boundingBox()
    if (!videoBox) throw new Error('视频没有可交互区域')
    const dimensions = await video.evaluate((el) => ({
      width: el.videoWidth,
      height: el.videoHeight,
    }))
    const scale = Math.min(videoBox.width / dimensions.width, videoBox.height / dimensions.height)
    const content = {
      x: videoBox.x + (videoBox.width - dimensions.width * scale) / 2,
      y: videoBox.y + (videoBox.height - dimensions.height * scale) / 2,
      width: dimensions.width * scale,
      height: dimensions.height * scale,
    }
    if (action === 'manual') {
      await video.evaluate((el) => el.pause())
      // controlsList="nofullscreen" 下 Chromium 单击画面不再切换播放，用聚焦后的空格键恢复
      await video.focus()
      await page.keyboard.press('Space')
    } else if (action === 'seek') {
      const y = content.y + content.height - 15
      await page.mouse.move(content.x + content.width / 2, content.y + content.height / 2)
      await page.mouse.move(content.x + content.width * 0.2, y)
      await page.waitForTimeout(150)
      await page.mouse.down()
      await page.mouse.move(content.x + content.width * 0.8, y, { steps: 12 })
      await page.mouse.up()
      await expect.poll(() => video.evaluate((el) => el.currentTime)).toBeGreaterThan(4)
    } else if (action === 'ended') {
      await video.evaluate((el) => {
        el.currentTime = Math.max(0, el.duration - 0.2)
      })
      await expect.poll(() => video.evaluate((el) => el.ended)).toBe(true)
    }
    if (action !== 'ended') await expect.poll(() => video.evaluate((el) => el.paused)).toBe(false)
    record.media = await video.evaluate((el) => ({
      paused: el.paused,
      ended: el.ended,
      currentTime: el.currentTime,
      readyState: el.readyState,
      active: document.activeElement === el,
      error: el.error?.message ?? null,
    }))
    await video.evaluate((el) => {
      window.__historyVideo = el
    })
    if (viewerExit === 'escape') await page.keyboard.press('Escape')
    else if (viewerExit === 'backdrop') await page.mouse.click(3, 3)
    else await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(viewer).toHaveCount(0)
    record.closing = await page.evaluate(() => ({
      paused: window.__historyVideo.paused,
      src: window.__historyVideo.getAttribute('src'),
      connected: window.__historyVideo.isConnected,
    }))
    expect(record.closing.paused).toBe(true)
    expect(record.closing.src).toBeNull()
    await expect.poll(() => page.evaluate(() => window.__historyVideo.isConnected)).toBe(false)
    record.released = await page.evaluate(() => ({
      paused: window.__historyVideo.paused,
      src: window.__historyVideo.getAttribute('src'),
      connected: window.__historyVideo.isConnected,
    }))
    await page.evaluate(() => {
      window.__historyCloseEvents = []
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'])
        window.addEventListener(
          type,
          (event) =>
            window.__historyCloseEvents.push({
              type,
              target: event.target?.outerHTML?.slice(0, 160) ?? null,
            }),
          true,
        )
    })
    const close = history.getByRole('button', { name: '关闭', exact: true })
    const box = await close.boundingBox()
    if (!box) throw new Error('生成历史关闭按钮不可见')
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    record.beforeClose = await page.evaluate(
      ({ x, y }) => ({
        hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 240) ?? null,
        active: document.activeElement?.outerHTML.slice(0, 160) ?? null,
        inert: [...document.querySelectorAll('[inert]')].map((el) => el.outerHTML.slice(0, 160)),
      }),
      point,
    )
    await page.mouse.click(point.x, point.y)
    await page.waitForTimeout(200)
    record.afterClose = await page.evaluate(() => ({
      events: window.__historyCloseEvents,
      inert: [...document.querySelectorAll('[inert]')].map((el) => el.outerHTML.slice(0, 160)),
      dialogs: [...document.querySelectorAll('[role=dialog]')].map((el) => ({
        label: el.getAttribute('aria-label'),
        exiting: el.hasAttribute('data-plein-exiting'),
      })),
    }))
    await expect(history).toHaveCount(0, { timeout: 2000 })
    expect(record.released).toEqual({ paused: true, src: null, connected: false })
    expect(record.beforeClose.inert).toEqual([])
    expect(record.afterClose.inert).toEqual([])
    expect(record.afterClose.events.some((event) => event.type === 'click')).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await electron?.close()
  }
}
