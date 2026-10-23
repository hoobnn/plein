import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from './fixtures'
import { arrangeSequence, sequenceNode, subtitleInputKey } from '../packages/nodes/src/sequence'
import { addNode, centerOf, newProject, zoomTo } from './canvas'

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

test('透明叠加真实alpha：原生解码、层序、几何和opacity、隐藏、一次撤销与只读', async ({ page }) => {
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
  await expect(f.editor.getByRole('spinbutton', { name: '叠加X', exact: true })).toHaveValue('0.25')
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
})

test('动画字幕真实透明Player：出现消失边界、统一cue、切换none与静态、手改manual和释放', async ({
  page,
}) => {
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
})

test('叠加锚点跟随镜头重排，入点和变速后的字幕先提示过期，再显式重建对齐', async ({ page }) => {
  const posted: { cues: { source?: string; start: number; end: number }[]; duration: number }[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/api/motion/preview/captions') && request.method() === 'POST')
      posted.push(request.postDataJSON())
  })
  const f = await fixture(page, true)
  await expect(f.editor.getByLabel('HyperFrames动画字幕', { exact: true })).toHaveAttribute(
    'data-state',
    'ready',
  )
  await f.editor.getByRole('button', { name: '后移', exact: true }).click()
  // 重排只换先后，字幕跟着自己的镜头走，不算过期
  await expect(f.editor).not.toContainText('字幕已过期')
  await expect
    .poll(() => posted.at(-1)?.cues.find((cue) => cue.source === 'clip-a')?.start)
    .toBe(1.2)
  await seek(page, f.editor, 0.4)
  await expect.poll(async () => (await pixel(f.canvas, 0.375, 0.5))[2]).toBeGreaterThan(180)
  await seek(page, f.editor, 1.4)
  await expect.poll(async () => (await pixel(f.canvas, 0.375, 0.5))[1]).toBeGreaterThan(180)
  await choose(page, f.editor, '速度', '1×')
  await expect.poll(() => posted.at(-1)?.duration).toBe(3)
  await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
  // 变速改了镜头时长，字幕时间对不上，要先提示过期
  await expect(f.editor).toContainText('字幕已过期')
  await f.editor
    .getByRole('button', { name: '按当前台词重建字幕（替换手改）', exact: true })
    .click()
  await expect(f.editor).not.toContainText('字幕已过期')
})

test('动态合成可选择透明WebM输出，只读禁用格式修改', async ({ page }) => {
  await newProject(page)
  await addNode(page, '动态合成')
  const id = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/motion')!.id,
  )
  await zoomTo(page, [id])
  const point = await centerOf(page, id)
  await page.mouse.dblclick(point.x, point.y)
  const panel = page.getByRole('dialog', { name: '动态合成', exact: true })
  await choose(page, panel, '动态合成输出格式', '透明 WebM（叠加素材）')
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.output, id))
    .toBe('transparent-webm')
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      readOnly: boolean
    }
    doc.readOnly = true
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
      'name',
      '透明输出只读',
    )
  }, id)
  await expect(
    panel.getByRole('combobox', { name: '动态合成输出格式', exact: true }),
  ).toBeDisabled()
})

test('动画字幕创建迟到响应在切换none后立即释放，不恢复旧iframe，重开可预览', async ({ page }) => {
  let release!: () => void, started!: () => void
  const hold = new Promise<void>((resolve) => {
      release = resolve
    }),
    reached = new Promise<void>((resolve) => {
      started = resolve
    })
  let created = ''
  const deleted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deleted.push(request.url())
  })
  await page.route('**/api/motion/preview/captions', async (route) => {
    const response = await route.fetch()
    created = ((await response.json()) as { id: string }).id
    started()
    await hold
    await route.fulfill({ response })
  })
  const f = await fixture(page, true)
  await reached
  await f.editor.getByRole('button', { name: '成片', exact: true }).click()
  await choose(page, f.editor, '字幕渲染', '不烧录（保留SRT）')
  release()
  await expect
    .poll(() => deleted.some((url) => url.endsWith(`/api/motion/preview/${created}`)))
    .toBe(true)
  await expect(f.editor.getByLabel('HyperFrames动画字幕', { exact: true })).toHaveCount(0)
  await page.unroute('**/api/motion/preview/captions')
  await choose(page, f.editor, '字幕渲染', '动画字幕（HyperFrames）')
  await expect(f.editor.getByLabel('HyperFrames动画字幕', { exact: true })).toHaveAttribute(
    'data-state',
    'ready',
  )
})
