/** Installed acceptance app only. Seed through the public Yjs protocol and exercise real UI/export. */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron, expect } from '@playwright/test'
import {
  createDoc,
  createElement,
  connect,
  adoptResult,
  currentResult,
} from '../../../packages/doc/src/index'
import {
  MotionParams,
  motionNode,
  sequenceNode,
  arrangeSequence,
  subtitleInputKey,
} from '../../../packages/nodes/src/index'

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url))
const { WebsocketProvider } = await import(
  new URL('../../server/node_modules/y-websocket/src/y-websocket.js', import.meta.url).href
)
const WebSocket = requireServer('ws')
const { unzipSync, strFromU8 } = requireServer('fflate')
const installed = resolve(process.argv[2]!)
const evidence = resolve(process.argv[3]!)
if (!installed.endsWith('Plein Acceptance.app') || !process.argv[3])
  throw new Error('Pass installed acceptance .app and evidence directory')
mkdirSync(evidence, { recursive: true })
const resource = join(installed, 'Contents/Resources')
const ffmpeg = join(resource, 'ffmpeg/ffmpeg'),
  ffprobe = join(resource, 'ffmpeg/ffprobe')
const executablePath = join(installed, 'Contents/MacOS/Plein Acceptance')
const baseFile = join(evidence, 'base.mp4')
execFileSync(ffmpeg, [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x134578:s=640x360:r=30:d=3',
  '-f',
  'lavfi',
  '-i',
  'sine=f=440:d=3',
  '-c:v',
  'h264_videotoolbox',
  '-b:v',
  '2000k',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-shortest',
  baseFile,
])
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      ![
        'ELECTRON_RUN_AS_NODE',
        'NODE_OPTIONS',
        'PLEIN_DATA_DIR',
        'PLEIN_DESKTOP_PROFILE',
        'PLEIN_ACCEPTANCE_NAMESPACE',
        'PLEIN_FFMPEG_PATH',
        'PLEIN_FFPROBE_PATH',
        'PLEIN_WEB_DIST',
        'PLEIN_PORT',
      ].includes(key),
  ),
) as Record<string, string>
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
let provider: { destroy(): void } | undefined
let disposeDoc: (() => void) | undefined
const errors: string[] = []
const evidenceData: Record<string, unknown> = {
  installed,
  executablePath,
  resource,
  profile: 'acceptance',
}
const launch = async () => {
  const instance = await _electron.launch({ executablePath, env: cleanEnv, timeout: 60_000 })
  app = instance
  const page = await instance.firstWindow({ timeout: 60_000 })
  const welcome = page.getByRole('dialog', { name: '欢迎使用 Plein', exact: true })
  await page
    .getByRole('button', { name: '新建项目', exact: true })
    .first()
    .or(welcome)
    .waitFor({ timeout: 30_000 })
  if (await welcome.isVisible())
    await welcome.getByRole('button', { name: '关闭', exact: true }).click()
  await page
    .getByRole('button', { name: '新建项目', exact: true })
    .first()
    .waitFor({ timeout: 20_000 })
  page.on('pageerror', (error) => errors.push(error.message))
  const runtime = await instance.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    version: app.getVersion(),
  }))
  expect(runtime.packaged).toBe(true)
  expect(runtime.userData).toContain('/Plein Acceptance/hyperframes-2026-10-23')
  expect(runtime.appPath).toBe(join(resource, 'app.asar'))
  expect(
    await page.evaluate(() => typeof (window as unknown as { __plein?: unknown }).__plein),
  ).toBe('undefined')
  return { instance, page, runtime }
}
try {
  const opened = await launch()
  app = opened.instance
  const page = opened.page
  evidenceData.runtime = opened.runtime
  const origin = new URL(page.url()).origin
  const cookie = await app.evaluate(async ({ session }) =>
    (await session.defaultSession.cookies.get({ name: 'plein_desktop' }))
      .map((c) => `${c.name}=${c.value}`)
      .join('; '),
  )
  const api = async (path: string, data?: unknown) => {
    const response =
      data === undefined
        ? await page.request.get(origin + path)
        : await page.request.post(origin + path, { data })
    if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`)
    return response.json()
  }
  const project = await api('/api/projects', { title: 'HyperFrames 安装包验收' })
  const canvasId = project.lastCanvasId
  const uploaded = await page.request.post(origin + '/api/assets', {
    data: readFileSync(baseFile),
    headers: { 'content-type': 'video/mp4', 'x-file-name': 'installed-base.mp4' },
  })
  expect(uploaded.status()).toBe(201)
  const baseAsset = await uploaded.json()
  class AuthSocket extends WebSocket {
    constructor(url: string, protocols?: string[]) {
      super(url, protocols, { headers: { cookie } })
    }
  }
  const doc = createDoc()
  const sync = new WebsocketProvider(origin.replace('http:', 'ws:') + '/sync', canvasId, doc.ydoc, {
    WebSocketPolyfill: AuthSocket,
    disableBc: true,
  })
  provider = sync
  disposeDoc = () => {
    sync.awareness.destroy()
    doc.destroy()
  }
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('sync timeout')), 15_000)
    sync.on('sync', (ready: boolean) => {
      if (ready) {
        clearTimeout(timer)
        done()
      }
    })
  })
  const ports = (node: typeof motionNode | typeof sequenceNode) => ({
    inputs: node.inputs.map((p) => ({ ...p })),
    outputs: node.outputs.map((p) => ({ ...p })),
  })
  const motionId = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/motion',
    nodeVersion: 1,
    name: '安装包透明标题',
    x: 0,
    y: 0,
    w: 240,
    h: 180,
    ports: ports(motionNode),
    params: MotionParams.parse({
      title: 'ALPHA TITLE',
      subtitle: 'Installed HyperFrames',
      duration: 3,
      aspectRatio: '16:9',
      resolution: '720p',
      output: 'transparent-webm',
    }),
  })
  const videoId = createElement(doc, {
    kind: 'video',
    name: '底片',
    assetId: baseAsset.id,
    x: -400,
    y: 0,
    w: 240,
    h: 135,
    ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
  })
  const params = sequenceNode.params.parse({
    aspectRatio: '16:9',
    resolution: '720p',
    subtitles: true,
    subtitleRender: 'animated',
    subtitleAnimation: 'pop',
    subtitleStyle: '底框',
    loudnorm: false,
    clips: [{ source: videoId }],
    overlays: [
      {
        id: 'installed-overlay',
        source: motionId,
        start: 0.2,
        duration: 2.5,
        x: 0.1,
        y: 0.05,
        width: 0.7,
        height: 0.7,
        opacity: 0.8,
      },
    ],
  })
  const arranged = arrangeSequence(params, {
    clips: [{ type: 'video', kind: 'video', assetId: baseAsset.id, source: videoId }],
    dialogue: [],
    sfx: [],
  })
  params.subtitleTrack = {
    inputKey: subtitleInputKey(params, arranged),
    cues: [
      {
        id: 'manual-a',
        source: videoId,
        start: 0.3,
        end: 1.1,
        text: '安装包动画字幕验收',
        origin: 'manual',
        hidden: false,
      },
      {
        id: 'manual-b',
        source: videoId,
        start: 1.6,
        end: 2.6,
        text: '透明叠加与字幕共用时间线',
        origin: 'manual',
        hidden: false,
      },
    ],
  }
  const sequenceId = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/sequence',
    nodeVersion: 1,
    name: '安装包动画字幕与叠加',
    x: 400,
    y: 0,
    w: 240,
    h: 180,
    ports: ports(sequenceNode),
    params,
  })
  expect(connect(doc, [videoId, 'video'], [sequenceId, 'clips'])).toBeTruthy()
  expect(connect(doc, [motionId, 'video'], [sequenceId, 'overlays'])).toBeTruthy()
  await expect
    .poll(
      async () => (await api(`/api/canvases/${canvasId}/nodes/${motionId}/input`)).params?.title,
    )
    .toBe('ALPHA TITLE')
  const run = await api(`/api/canvases/${canvasId}/nodes/${motionId}/run`, {})
  await expect.poll(() => doc.get(motionId)?.run?.status, { timeout: 120_000 }).toBe('succeeded')
  const candidate = doc.get(motionId)!.results![0]!
  expect(currentResult(doc.get(motionId)!)).toBeUndefined()
  adoptResult(doc, motionId, candidate.id)
  if (candidate.value.type !== 'video') throw new Error('missing alpha video')
  const motionVideo = await page.request.get(origin + `/api/assets/${candidate.value.assetId}`)
  const motionFile = join(evidence, 'installed-motion.webm')
  writeFileSync(motionFile, await motionVideo.body())
  const motionProbe = JSON.parse(
    execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', motionFile], {
      encoding: 'utf8',
    }),
  )
  expect(motionProbe.streams[0].codec_name).toBe('vp9')
  expect(motionProbe.streams[0].tags.ALPHA_MODE ?? motionProbe.streams[0].tags.alpha_mode).toBe('1')
  expect(
    motionProbe.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio'),
  ).toHaveLength(0)
  const decodedAlpha = execFileSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-c:v',
      'libvpx-vp9',
      '-i',
      motionFile,
      '-ss',
      '0.5',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  )
  expect(decodedAlpha[(10 * 1280 + 10) * 4 + 3]).toBe(0)
  evidenceData.motion = {
    runId: run.runId,
    assetId: candidate.value.assetId,
    compositionSource: candidate.value.compositionSource,
    probe: motionProbe,
  }
  await page.goto(origin + `/#/c/${canvasId}`)
  await page.getByRole('button', { name: '上传', exact: true }).waitFor()
  await app.evaluate(
    ({ BrowserWindow }, target) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('plein:open-node', target),
    { canvasId, nodeId: sequenceId },
  )
  await page.getByRole('button', { name: /^编辑序列（/ }).click()
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toBeVisible()
  await expect(editor.getByLabel('HyperFrames动画字幕')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  })
  await editor.getByRole('button', { name: '叠加', exact: true }).click()
  await expect(editor.getByRole('spinbutton', { name: '叠加不透明度', exact: true })).toHaveValue(
    '0.8',
  )
  await editor.getByRole('spinbutton', { name: '叠加不透明度', exact: true }).fill('0.65')
  await editor.getByRole('spinbutton', { name: '叠加不透明度', exact: true }).press('Tab')
  await expect
    .poll(() => (doc.get(sequenceId)?.params?.overlays as { opacity: number }[])?.[0]?.opacity)
    .toBe(0.65)
  await editor.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(() => editor.locator('.seq-time').innerText()).toMatch(/0:00\.[6-9]|0:01/)
  await editor.getByRole('button', { name: '暂停', exact: true }).click()
  await page.screenshot({ path: join(evidence, 'installed-sequence-editor.png') })
  await editor.getByRole('button', { name: '导出 MP4', exact: true }).click()
  await expect.poll(() => doc.get(sequenceId)?.run?.status, { timeout: 180_000 }).toBe('succeeded')
  const film = currentResult(doc.get(sequenceId)!)
  if (film?.value.type !== 'video') throw new Error('missing final film')
  const filmFile = join(evidence, 'installed-film.mp4')
  writeFileSync(
    filmFile,
    await (await page.request.get(origin + `/api/assets/${film.value.assetId}`)).body(),
  )
  const filmProbe = JSON.parse(
    execFileSync(
      ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filmFile],
      { encoding: 'utf8' },
    ),
  )
  expect(filmProbe.streams[0].width).toBe(1280)
  expect(filmProbe.streams[0].height).toBe(720)
  expect(Number(filmProbe.format.duration)).toBeCloseTo(3, 1)
  // Decode final pixels: unchanged backdrop and visible caption at its active cue.
  const rgb = (time: number) =>
    execFileSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-ss',
        String(time),
        '-i',
        filmFile,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    )
  const gap = rgb(1.35),
    active = rgb(0.7)
  const transparentPixel = (80 * 1280 + 150) * 3
  const backdrop = [0x13, 0x45, 0x78]
  for (let c = 0; c < 3; c++)
    expect(Math.abs(active[transparentPixel + c]! - backdrop[c]!)).toBeLessThan(12)
  evidenceData.alpha = {
    decodedClearCorner: decodedAlpha[(10 * 1280 + 10) * 4 + 3],
    compositedClearCorner: [...active.subarray(transparentPixel, transparentPixel + 3)],
  }
  let differences = 0
  for (let y = 580; y < 715; y++)
    for (let x = 100; x < 1180; x++) {
      const i = (y * 1280 + x) * 3
      if (
        Math.abs(active[i]! - gap[i]!) +
          Math.abs(active[i + 1]! - gap[i + 1]!) +
          Math.abs(active[i + 2]! - gap[i + 2]!) >
        80
      )
        differences++
    }
  expect(differences).toBeGreaterThan(1000)
  execFileSync(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-ss',
    '0.7',
    '-i',
    filmFile,
    '-frames:v',
    '1',
    join(evidence, 'installed-film-frame.png'),
  ])
  evidenceData.film = {
    assetId: film.value.assetId,
    probe: filmProbe,
    captionPixelDifferences: differences,
  }
  const zipFile = join(evidence, 'installed-sequence.zip')
  rmSync(zipFile, { force: true })
  await app.evaluate(({ session }, filePath) => {
    const state = globalThis as { __pleinAcceptanceDownload?: string }
    state.__pleinAcceptanceDownload = 'waiting'
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(filePath)
      item.once('done', (_event, result) => {
        state.__pleinAcceptanceDownload = result
      })
    })
  }, zipFile)
  await editor.getByRole('button', { name: '导出工程', exact: true }).click()
  await expect
    .poll(
      () =>
        app!.evaluate(
          () => (globalThis as { __pleinAcceptanceDownload?: string }).__pleinAcceptanceDownload,
        ),
      { timeout: 30_000 },
    )
    .toBe('completed')
  const zip = unzipSync(readFileSync(zipFile))
  const names = Object.keys(zip)
  expect(names.some((n) => n.endsWith('.otio'))).toBe(true)
  expect(names.some((n) => n.endsWith('.fcpxml'))).toBe(true)
  expect(names.some((n) => n.includes('captions') && n.endsWith('source.zip'))).toBe(true)
  expect(names.some((n) => /sources\/\d+\/source\.zip$/.test(n))).toBe(true)
  evidenceData.package = {
    bytes: readFileSync(zipFile).length,
    files: names,
    srt: names.filter((n) => n.endsWith('.srt')).map((n) => ({ name: n, text: strFromU8(zip[n]) })),
  }
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  evidenceData.ids = { projectId: project.id, canvasId, motionId, sequenceId }
  provider.destroy()
  provider = undefined
  disposeDoc()
  disposeDoc = undefined
  await app.close()
  app = undefined
  const reopened = await launch()
  app = reopened.instance
  await reopened.page.goto(new URL(reopened.page.url()).origin + `/#/c/${canvasId}`)
  await reopened.page.getByRole('button', { name: '上传', exact: true }).waitFor()
  await app.evaluate(
    ({ BrowserWindow }, target) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('plein:open-node', target),
    { canvasId, nodeId: sequenceId },
  )
  await reopened.page.getByRole('button', { name: /^编辑序列（/ }).click()
  const restored = reopened.page.getByRole('dialog', { name: '序列', exact: true })
  await expect(restored.getByLabel('HyperFrames动画字幕')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  })
  await restored.getByRole('button', { name: '叠加', exact: true }).click()
  await expect(restored.getByRole('spinbutton', { name: '叠加不透明度', exact: true })).toHaveValue(
    '0.65',
  )
  await expect(restored.getByRole('button', { name: '另存为…', exact: true })).toBeVisible()
  await reopened.page.screenshot({ path: join(evidence, 'installed-restart-restored.png') })
  evidenceData.restart = {
    runtime: reopened.runtime,
    restoredOpacity: 0.65,
    filmRetained: true,
    captionPreview: 'ready',
  }
  await restored.getByRole('button', { name: '关闭', exact: true }).click()
  const restoredOrigin = new URL(reopened.page.url()).origin
  const manifestId = candidate.value.compositionSource!.manifestAssetId
  const sourceRead = await reopened.page.request.get(
    `${restoredOrigin}/api/motion/source/${manifestId}`,
  )
  expect(sourceRead.status()).toBe(200)
  expect((await sourceRead.json()).params.output).toBe('transparent-webm')
  const restoredSource = await reopened.page.request.post(
    `${restoredOrigin}/api/motion/source/${manifestId}/restore`,
    { data: { canvasId } },
  )
  expect(restoredSource.status()).toBe(201)
  const sourceNode = await restoredSource.json()
  await app.evaluate(
    ({ BrowserWindow }, target) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('plein:open-node', target),
    { canvasId, nodeId: sourceNode.nodeId },
  )
  await reopened.page
    .locator('.plein-node-head')
    .filter({ hasText: 'ALPHA TITLE · 源版本' })
    .getByRole('button', { name: '编辑动态合成', exact: true })
    .click()
  const sourceEditor = reopened.page.getByRole('dialog', { name: '动态合成', exact: true })
  await expect(sourceEditor.locator('.motion-preview')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  })
  await expect(
    sourceEditor.getByRole('combobox', { name: '动态合成输出格式', exact: true }),
  ).toContainText('透明 WebM')
  await reopened.page.screenshot({ path: join(evidence, 'installed-source-restored.png') })
  evidenceData.sourceRestore = {
    manifestId,
    nodeId: sourceNode.nodeId,
    output: 'transparent-webm',
    preview: 'ready',
  }
  expect(errors).toEqual([])
  evidenceData.pageErrors = errors
  evidenceData.passed = true
  rmSync(join(evidence, 'failure.png'), { force: true })
  rmSync(join(evidence, 'failure-dom.txt'), { force: true })
  writeFileSync(
    join(evidence, 'installed-acceptance.json'),
    JSON.stringify(evidenceData, null, 2) + '\n',
  )
  console.log(
    JSON.stringify({
      passed: true,
      evidence,
      filmAsset: film.value.assetId,
      captionPixelDifferences: differences,
      files: names.length,
    }),
  )
} catch (error) {
  evidenceData.passed = false
  evidenceData.error = String(error)
  evidenceData.pageErrors = errors
  writeFileSync(
    join(evidence, 'installed-acceptance.json'),
    JSON.stringify(evidenceData, null, 2) + '\n',
  )
  if (app) {
    const page = app.windows()[0]
    if (page) {
      await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
      writeFileSync(
        join(evidence, 'failure-dom.txt'),
        await page
          .locator('body')
          .innerText()
          .catch(() => ''),
      )
    }
  }
  throw error
} finally {
  provider?.destroy()
  disposeDoc?.()
  await app?.close()
}
