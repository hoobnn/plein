import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'
import { animaticNode, arrangeAnimatic } from '../packages/nodes/src/animatic'
import { arrangeSequence, sequenceNode, subtitleInputKey } from '../packages/nodes/src/sequence'

const font = readFileSync(
  new URL('../apps/web/node_modules/jassub/dist/default.woff2', import.meta.url),
)
async function setup(
  page: Page,
  fault: { info?: boolean; file?: boolean; gate?: Promise<void>; gateFileOnly?: boolean } = {},
  source: { script?: string; secondShot?: boolean } = {},
) {
  await page.route('**/api/media/subtitle-font', async (route) => {
    if (!fault.gateFileOnly) await fault.gate
    return fault.info
      ? route.fulfill({ status: 503, json: { message: '字体信息暂不可用' } })
      : route.fulfill({ json: { family: 'Liberation Sans', version: 'subtitle-e2e' } })
  })
  await page.context().route('**/api/media/subtitle-font/file?*', async (route) => {
    await fault.gate
    return fault.file
      ? route.fulfill({ status: 503, body: 'font unavailable' })
      : route.fulfill({ contentType: 'font/woff2', body: font })
  })
  await newProject(page)
  const params = animaticNode.params.parse({
    subtitles: true,
    aspectRatio: '16:9',
    shots: [
      { shotId: 'one', duration: 6, dialogue: [], subtitle: source.script },
      ...(source.secondShot ? [{ shotId: 'two', duration: 4, dialogue: [] }] : []),
    ],
  })
  params.subtitleTrack = {
    inputKey: subtitleInputKey(params, arrangeAnimatic(params)),
    cues: [
      {
        id: 'a',
        source: 'one',
        start: 0,
        end: 1,
        text: 'Subtitle ready',
        origin: 'manual',
        hidden: false,
      },
      {
        id: 'b',
        source: 'one',
        start: 3,
        end: 5,
        text: 'Later subtitle',
        origin: 'manual',
        hidden: false,
      },
    ],
  }
  const id = await page.evaluate(
    (params) =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '字幕渲染实测',
        x: 300,
        y: 200,
        params,
      }),
    params,
  )
  const open = async () => {
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await expect(editor).toBeVisible()
    return editor
  }
  return {
    id,
    open,
    editor: await open(),
    original: await page.evaluate(() => [...window.__plein.engine.doc.elements()]),
  }
}

async function lit(page: Page, image: Buffer) {
  return page.evaluate(async (base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`)
    const bitmap = await createImageBitmap(await response.blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(
      Math.floor(canvas.width * 0.1),
      Math.floor(canvas.height * 0.65),
      Math.floor(canvas.width * 0.8),
      Math.floor(canvas.height * 0.3),
    )
    bitmap.close()
    let count = 0
    for (let i = 0; i < data.length; i += 4)
      if (data[i]! > 160 && data[i + 1]! > 160 && data[i + 2]! > 160) count++
    return count
  }, image.toString('base64'))
}

test(
  '实际 libass 字幕按时间出现消失，关闭重开可继续渲染且不留 worker',
  { tag: '@core' },
  async ({ page }) => {
    const warnings: string[] = [],
      errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('[字幕预览]'))
        warnings.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    const f = await setup(page)
    const stage = f.editor.locator('.seq-stage')
    await expect(stage).toHaveAttribute('data-subtitles', 'libass')
    const pixels = async () => lit(page, await stage.screenshot({ animations: 'disabled' }))
    await expect.poll(pixels).toBeGreaterThan(50)
    await f.editor.getByRole('button', { name: '回到开头', exact: true }).click()
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(pixels).toBeLessThan(10)
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(pixels).toBeGreaterThan(50)
    await stage.screenshot({
      path: test.info().outputPath('libass-subtitle.png'),
      animations: 'disabled',
    })
    await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(f.editor).toHaveCount(0)
    await expect.poll(() => page.workers().length).toBe(0)
    const again = await f.open()
    await expect(again.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'libass')
    await expect
      .poll(async () => lit(page, await again.locator('.seq-stage').screenshot()))
      .toBeGreaterThan(50)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  },
)

let scratch = ''
const bytes: Record<string, Buffer> = {}
test.beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'plein-overlay-e2e-'))
  for (const [name, color, alpha] of [
    ['base', [20, 40, 220], false],
    ['green', [0, 220, 0], true],
    ['red', [220, 0, 0], true],
  ] as const) {
    const frame = Buffer.alloc(160 * 90 * 4)
    for (let y = 0; y < 90; y++)
      for (let x = 0; x < 160; x++)
        frame.set([...color, alpha && x >= 80 ? 0 : 255], (y * 160 + x) * 4)
    const path = join(scratch, `${name}.webm`)
    execFileSync(
      process.env.PLEIN_FFMPEG_PATH ?? 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        '160x90',
        '-r',
        '30',
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-lossless',
        '1',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-auto-alt-ref',
        '0',
        path,
      ],
      { input: Buffer.concat(Array.from({ length: 90 }, () => frame)) },
    )
    bytes[name] = readFileSync(path)
  }
})
test.afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

async function fixture(page: Page, animated = false) {
  await newProject(page)
  const assets: Record<string, string> = {}
  for (const name of ['base', 'green', 'red']) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/webm', 'x-file-name': `${name}.webm` },
      data: bytes[name],
    })
    expect(response.status()).toBe(201)
    assets[name] = (await response.json()).id
  }
  const ids = await page.evaluate((assets) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(value: unknown): void
    }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'a',
          kind: 'video',
          name: '蓝色镜头 A',
          assetId: assets.base,
          x: 0,
          y: 0,
          w: 160,
          h: 90,
          parentId: null,
        },
        {
          id: 'b',
          kind: 'video',
          name: '蓝色镜头 B',
          assetId: assets.base,
          x: 200,
          y: 0,
          w: 160,
          h: 90,
          parentId: null,
        },
        {
          id: 'green',
          kind: 'video',
          name: '绿色透明层',
          assetId: assets.green,
          x: 0,
          y: 200,
          w: 160,
          h: 90,
          parentId: null,
        },
        {
          id: 'red',
          kind: 'video',
          name: '红色透明层',
          assetId: assets.red,
          x: 200,
          y: 200,
          w: 160,
          h: 90,
          parentId: null,
        },
      ],
    })
    const all = [...engine.doc.elements()]
    return {
      a: all.find((el) => el.name === '蓝色镜头 A')!.id,
      b: all.find((el) => el.name === '蓝色镜头 B')!.id,
      green: all.find((el) => el.name === '绿色透明层')!.id,
      red: all.find((el) => el.name === '红色透明层')!.id,
    }
  }, assets)
  const params = sequenceNode.params.parse({
    resolution: '720p',
    aspectRatio: '16:9',
    subtitles: true,
    subtitleRender: animated ? 'animated' : 'none',
    subtitleAnimation: 'fade',
    clipVolume: 0,
    loudnorm: false,
    instanceVersion: 2,
    clips: [
      {
        clipInstanceId: 'clip-a',
        source: ids.a,
        port: 'video',
        sound: 'native',
        in: 0.5,
        out: 2.5,
        speed: 2,
      },
      { clipInstanceId: 'clip-b', source: ids.b, port: 'video', sound: 'native', in: 0, out: 1 },
    ],
    overlays: [
      {
        id: 'green-layer',
        source: ids.green,
        clip: ids.a,
        start: 0.2,
        in: 0.1,
        duration: 0.6,
        speed: 2,
        x: 0.25,
        y: 0.25,
        width: 0.5,
        height: 0.5,
      },
    ],
  })
  const arranged = arrangeSequence(params, {
    clips: [ids.a, ids.b].map((source) => ({
      type: 'video',
      source,
      sourcePort: 'video',
      assetId: assets.base!,
      kind: 'video',
    })),
  })
  params.subtitleTrack = {
    inputKey: subtitleInputKey(params, arranged),
    cues: [
      {
        id: 'cue-a',
        source: 'clip-a',
        start: 0.2,
        end: 0.8,
        text: '第一句透明动画字幕',
        origin: 'estimated',
        hidden: false,
      },
      {
        id: 'cue-b',
        source: 'clip-b',
        start: 0.2,
        end: 0.8,
        text: '第二句透明动画字幕',
        origin: 'manual',
        hidden: false,
      },
    ],
  }
  const id = await page.evaluate(
    ({ ids, params }) => {
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: '透明叠加和动画字幕',
        params,
        x: 650,
        y: 100,
      })
      // 直接写边：连线命令会把旧式镜头重建成另一套实例身份，这里要保住自己给的实例身份
      const edges = window.__plein.engine.doc.edgeMap
      edges.set('edge-a', { id: 'edge-a', from: [ids.a, 'video'], to: [id, 'clips'], order: 'a0' })
      edges.set('edge-b', { id: 'edge-b', from: [ids.b, 'video'], to: [id, 'clips'], order: 'a1' })
      edges.set('edge-green', {
        id: 'edge-green',
        from: [ids.green, 'video'],
        to: [id, 'overlays'],
        order: 'a0',
      })
      edges.set('edge-red', {
        id: 'edge-red',
        from: [ids.red, 'video'],
        to: [id, 'overlays'],
        order: 'a1',
      })
      return id
    },
    { ids, params },
  )
  await zoomTo(page, [id])
  const point = await centerOf(page, id)
  await page.mouse.dblclick(point.x, point.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toBeVisible()
  const canvas = editor.locator('.seq-stage > canvas')
  await expect.poll(() => canvas.getAttribute('data-decoder')).toBe('element')
  return { id, ids, editor, canvas, params }
}
async function seek(page: Page, editor: Locator, time: number, total = 2) {
  const sc = await editor.locator('.seq-scroll').boundingBox(),
    ruler = await editor.locator('.seq-ruler').boundingBox()
  const label = await editor
    .locator('.seq-label')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width)
  const width = await editor.locator('.seq-scroll').evaluate((el) => el.clientWidth)
  await page.mouse.click(
    sc!.x + label + 16 + ((width - label - 32) * time) / total,
    ruler!.y + ruler!.height / 2,
  )
}
const pixel = (canvas: Locator, x: number, y: number) =>
  canvas.evaluate(
    (el: HTMLCanvasElement, at) => [
      ...el
        .getContext('2d')!
        .getImageData(Math.floor(el.width * at.x), Math.floor(el.height * at.y), 1, 1).data,
    ],
    { x, y },
  )
async function number(editor: Locator, name: string, value: string) {
  const field = editor.getByRole('spinbutton', { name, exact: true })
  await field.fill(value)
  await field.press('Tab')
}
async function choose(page: Page, editor: Locator, name: string, option: string) {
  await editor.getByRole('combobox', { name, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
async function whitePixels(page: Page, stage: Locator) {
  const png = await stage.screenshot({ animations: 'disabled' })
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${data}`)).blob(),
    )
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const g = canvas.getContext('2d')!
    g.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pixels = g.getImageData(
      Math.floor(canvas.width * 0.1),
      Math.floor(canvas.height * 0.65),
      Math.floor(canvas.width * 0.8),
      Math.floor(canvas.height * 0.35),
    ).data
    let white = 0
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i]! > 170 && pixels[i + 1]! > 170 && pixels[i + 2]! > 170) white++
    return white
  }, png.toString('base64'))
}

test(
  '透明叠加真实alpha：原生解码、层序、几何和opacity、隐藏、一次撤销与只读',
  { tag: '@core' },
  async ({ page }) => {
    const f = await fixture(page)
    await seek(page, f.editor, 0.4)
    await expect(f.canvas).toHaveAttribute('data-overlay-decoder', 'element')
    await expect.poll(async () => (await pixel(f.canvas, 0.375, 0.5))[1]).toBeGreaterThan(180)
    await expect.poll(async () => (await pixel(f.canvas, 0.625, 0.5))[2]).toBeGreaterThan(180)
    expect((await pixel(f.canvas, 0.625, 0.5))[1]).toBeLessThan(70)
    await f.editor.getByRole('button', { name: '叠加', exact: true }).click()
    await number(f.editor, '叠加不透明度', '.5')
    await expect.poll(async () => (await pixel(f.canvas, 0.375, 0.5))[2]).toBeGreaterThan(80)
    await number(f.editor, '叠加不透明度', '1')
    const handle = f.editor.getByRole('button', { name: '选择叠加图层 1', exact: true })
    const bounds = (await handle.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2, {
      steps: 4,
    })
    await page.mouse.up()
    await expect
      .poll(() =>
        page.evaluate(
          (id) => (window.__plein.engine.doc.get(id)!.params!.overlays as { x: number }[])[0]!.x,
          f.id,
        ),
      )
      .toBeGreaterThan(0.25)
    await page.keyboard.press('Control+z')
    await expect(f.editor.getByRole('spinbutton', { name: '叠加X', exact: true })).toHaveValue(
      '0.25',
    )
    await f.editor.getByRole('button', { name: '新增叠加', exact: true }).click()
    await choose(page, f.editor, '叠加来源', '红色透明层')
    await number(f.editor, '叠加X', '.25')
    await number(f.editor, '叠加Y', '.25')
    await number(f.editor, '叠加宽度', '.5')
    await number(f.editor, '叠加高度', '.5')
    await expect.poll(async () => (await pixel(f.canvas, 0.375, 0.5))[0]).toBeGreaterThan(180)
    await f.editor.getByRole('button', { name: '下移一层', exact: true }).click()
    await expect.poll(async () => (await pixel(f.canvas, 0.375, 0.5))[1]).toBeGreaterThan(180)
    await f.editor.screenshot({ path: test.info().outputPath('ui-alpha-overlays.png') })
    await f.editor.getByRole('checkbox', { name: '显示此叠加图层', exact: true }).uncheck()
    const saved = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)!.params!.overlays,
      f.id,
    )
    expect((saved as { hidden: boolean }[])[0]!.hidden).toBe(true)
    await page.keyboard.press('Control+z')
    await expect(
      f.editor.getByRole('checkbox', { name: '显示此叠加图层', exact: true }),
    ).toBeChecked()
    await page.evaluate((id) => {
      const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        readOnly: boolean
      }
      doc.readOnly = true
      ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
        'name',
        '叠加只读',
      )
    }, f.id)
    await expect(f.editor.getByRole('button', { name: '新增叠加', exact: true })).toBeDisabled()
    await expect(f.editor.getByRole('spinbutton', { name: '叠加X', exact: true })).toBeDisabled()
  },
)

test(
  '动画字幕真实透明Player：出现消失边界、统一cue、切换none与静态、手改manual和释放',
  { tag: '@core' },
  async ({ page }) => {
    const posted: {
      cues: { start: number; end: number; text: string; origin?: string }[]
      duration: number
    }[] = []
    const deleted: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/api/motion/preview/captions') && request.method() === 'POST')
        posted.push(request.postDataJSON())
      if (request.method() === 'DELETE' && request.url().includes('/api/motion/preview/'))
        deleted.push(request.url())
    })
    const f = await fixture(page, true)
    const captions = f.editor.getByLabel('HyperFrames动画字幕', { exact: true }),
      stage = f.editor.locator('.seq-stage')
    await expect(captions).toHaveAttribute('data-state', 'ready')
    expect(posted.at(-1)!.cues).toMatchObject([
      { source: 'clip-a', origin: 'estimated', start: 0.2, end: 0.8 },
      { source: 'clip-b', origin: 'manual', start: 1.2, end: 1.8 },
    ])
    await seek(page, f.editor, 0.1)
    await expect.poll(() => whitePixels(page, stage)).toBeLessThan(10)
    await seek(page, f.editor, 0.45)
    await expect.poll(() => whitePixels(page, stage)).toBeGreaterThan(50)
    await f.editor.screenshot({ path: test.info().outputPath('ui-animated-captions.png') })
    await seek(page, f.editor, 0.9)
    await expect.poll(() => whitePixels(page, stage)).toBeLessThan(10)
    await f.editor.getByRole('button', { name: '跳到结尾', exact: true }).click()
    await expect.poll(() => whitePixels(page, stage)).toBeLessThan(10)
    await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
    const text = f.editor.getByRole('textbox', { name: '镜头 1 字幕 1 文本', exact: true })
    await text.fill('人工校订后字幕')
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (
              window.__plein.engine.doc.get(id)!.params!.subtitleTrack as {
                cues: { origin: string }[]
              }
            ).cues[0]!.origin,
          f.id,
        ),
      )
      .toBe('manual')
    await f.editor.getByRole('button', { name: '成片', exact: true }).click()
    await choose(page, f.editor, '字幕渲染', '不烧录（保留SRT）')
    await expect(captions).toHaveCount(0)
    await expect(f.editor.locator('.seq-stage canvas')).toHaveCount(1)
    await expect.poll(() => deleted.length).toBeGreaterThan(0)
    await choose(page, f.editor, '字幕渲染', '静态字幕')
    await expect(stage).toHaveAttribute('data-subtitles', 'libass')
    await choose(page, f.editor, '字幕渲染', '动画字幕（HyperFrames）')
    await expect(captions).toHaveAttribute('data-state', 'ready')
    const before = deleted.length
    await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(f.editor).toHaveCount(0)
    await expect.poll(() => deleted.length).toBeGreaterThan(before)
  },
)
