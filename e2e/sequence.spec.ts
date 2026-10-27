import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import {
  addNode,
  centerOf,
  clickElement,
  edgesInto,
  elements,
  newProject,
  settle,
  zoomTo,
} from './canvas'
import { slowFile } from './slow-file'

let dir = ''
/** WebM（VP9）：Playwright 自带的 Chromium 没有 H.264 解码器，WebM 才能走 WebCodecs 预览 */
const shots = ['shot-a.webm', 'shot-b.webm', 'shot-c.webm']
/** PLEIN_E2E_SHOTS=目录：顺手把编辑器截图存下来（看效果用，CI 不设） */
const shotDir = process.env.PLEIN_E2E_SHOTS

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-seq-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  const sources = ['testsrc2', 'smptebars', 'rgbtestsrc']
  shots.forEach((name, i) =>
    ff(
      '-f',
      'lavfi',
      '-i',
      `${sources[i]}=s=360x640:d=${2 + i * 0.5}:r=30`,
      '-f',
      'lavfi',
      '-i',
      `sine=f=${300 + i * 100}:d=${2 + i * 0.5}`,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-c:a',
      'libopus',
      '-pix_fmt',
      'yuv420p',
      '-shortest',
      join(dir, name),
    ),
  )
  ff(
    '-f',
    'lavfi',
    '-i',
    'sine=f=520:d=1.5',
    '-af',
    'volume=0.6,tremolo=f=4:d=0.8',
    join(dir, 'line.wav'),
  )
  ff('-f', 'lavfi', '-i', 'sine=f=220:d=9', '-af', 'tremolo=f=1.5:d=0.6', join(dir, 'music.wav'))
  ff(
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=360x640:d=0.1:r=30',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'short.webm'),
  )
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('不足 0.2 秒的镜头拖动入点不写入负数，编辑器保持可用', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles(join(dir, 'short.webm'))
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
    .toBe(1)
  const video = (await elements(page)).find((e) => e.kind === 'video')!
  await addNode(page, '序列', { x: 720, y: 800 })
  await page.keyboard.press('Escape')
  const sequence = (await elements(page)).find((e) => e.nodeType === 'plein/sequence')!
  expect(
    await page.evaluate(
      ({ video, sequence }) => window.__plein.connect([video, 'video'], [sequence, 'clips']),
      { video: video.id, sequence: sequence.id },
    ),
  ).toBe(true)
  await zoomTo(page, [sequence.id])
  const at = await centerOf(page, sequence.id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const clip = editor.locator('.seq-clip').first()
  await expect(clip).toBeVisible()
  await clip.hover()
  const handle = clip.locator('.seq-trim-in')
  const bounds = (await handle.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 20, bounds.y + bounds.height / 2, { steps: 4 })
  await page.mouse.up()
  expect(errors).toEqual([])
  await expect(editor.getByRole('spinbutton', { name: '入点（秒）', exact: true })).toHaveValue('0')
  await clip.hover()
  const end = (await clip.locator('.seq-trim-out').boundingBox())!
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2)
  await page.mouse.down()
  await page.mouse.move(end.x - 20, end.y + end.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(editor.getByRole('spinbutton', { name: '出点（秒）', exact: true })).toHaveValue('')
  expect(errors).toEqual([])
  expect(
    await page.evaluate((id) => {
      const clips = window.__plein.engine.doc.get(id)!.params!.clips as {
        in: number
        out?: number
      }[]
      return { in: clips[0]!.in, out: clips[0]!.out ?? null }
    }, sequence.id),
  ).toEqual({ in: 0, out: null })
  await editor.getByRole('button', { name: '导出 MP4', exact: true }).click()
  const exported = editor.getByLabel('实际导出 MP4', { exact: true })
  await expect(exported).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(() => exported.evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration)))
    .toBe(true)
  const length = await exported.evaluate((v: HTMLVideoElement) => v.duration)
  expect(length).toBeGreaterThan(0)
  expect(length).toBeLessThan(0.16)
  expect(
    (await page.request.get((await exported.getAttribute('src'))!)).headers()['content-type'],
  ).toContain('video/mp4')
  expect(errors).toEqual([])
})

test('手动修剪拒绝交叉入出点，提示原因且清空可恢复整段', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles(join(dir, shots[0]!))
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
    .toBe(1)
  const video = (await elements(page)).find((e) => e.kind === 'video')!
  await addNode(page, '序列', { x: 720, y: 800 })
  await page.keyboard.press('Escape')
  const sequence = (await elements(page)).find((e) => e.nodeType === 'plein/sequence')!
  expect(
    await page.evaluate(
      ({ video, sequence }) => window.__plein.connect([video, 'video'], [sequence, 'clips']),
      { video: video.id, sequence: sequence.id },
    ),
  ).toBe(true)
  await zoomTo(page, [sequence.id])
  const at = await centerOf(page, sequence.id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await editor.locator('.seq-clip').first().click()
  const start = editor.getByRole('spinbutton', { name: '入点（秒）', exact: true })
  const end = editor.getByRole('spinbutton', { name: '出点（秒）', exact: true })
  await start.fill('1.5')
  await start.blur()
  await end.fill('1')
  await end.blur()
  await expect(end).toHaveValue('')
  await expect(editor.getByRole('alert')).toContainText('出点需要晚于入点')
  await start.fill('3')
  await start.blur()
  await expect(start).toHaveValue('1.5')
  await expect(editor.getByRole('alert')).toContainText('入点需要早于出点')
  await expect(editor.getByRole('alert')).toBeInViewport()
  await editor
    .locator('.seq-inspector')
    .screenshot({ path: test.info().outputPath('trim-validation.png') })
  await end.fill('1.8')
  await end.blur()
  await expect(end).toHaveValue('1.8')
  await expect(editor.getByRole('alert')).toHaveCount(0)
  await end.fill('')
  await end.blur()
  await start.fill('')
  await start.blur()
  await expect(start).toHaveValue('0')
  await expect(end).toHaveValue('')
  expect(
    await page.evaluate((id) => {
      const clips = window.__plein.engine.doc.get(id)!.params!.clips as {
        in: number
        out?: number
      }[]
      return { in: clips[0]!.in, out: clips[0]!.out ?? null }
    }, sequence.id),
  ).toEqual({ in: 0, out: null })
  await editor.getByRole('button', { name: '导出 MP4', exact: true }).click()
  const exported = editor.getByLabel('实际导出 MP4', { exact: true })
  await expect(exported).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(() => exported.evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration)))
    .toBe(true)
  const length = await exported.evaluate((v: HTMLVideoElement) => v.duration)
  expect(length).toBeGreaterThan(1.95)
  expect(length).toBeLessThan(2.1)
})

test('缩略图和波形请求失败可见，重新加载预览恢复且保留剪辑', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles([join(dir, shots[0]!), join(dir, 'line.wav')])
  await expect
    .poll(
      async () =>
        (await elements(page)).filter((e) => e.kind === 'video' || e.kind === 'audio').length,
    )
    .toBe(2)
  const all = await elements(page)
  const video = all.find((e) => e.kind === 'video')!
  const audio = all.find((e) => e.kind === 'audio')!
  let fail = true
  const calls = { filmstrip: 0, peaks: 0 }
  await page.route('**/api/assets/*/filmstrip', (route) => {
    calls.filmstrip++
    return fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()
  })
  await page.route('**/api/assets/*/peaks', (route) => {
    calls.peaks++
    return fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()
  })
  await addNode(page, '序列', { x: 720, y: 800 })
  await page.keyboard.press('Escape')
  const sequence = (await elements(page)).find((e) => e.nodeType === 'plein/sequence')!
  await page.evaluate(
    ({ video, audio, sequence }) => {
      window.__plein.connect([video, 'video'], [sequence, 'clips'])
      window.__plein.connect([audio, 'audio'], [sequence, 'dialogue'])
    },
    { video: video.id, audio: audio.id, sequence: sequence.id },
  )
  await zoomTo(page, [sequence.id])
  const at = await centerOf(page, sequence.id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor.getByText('缩略图加载失败', { exact: true })).toBeVisible()
  await expect(editor.getByText('波形加载失败', { exact: true })).toBeVisible()
  await editor.screenshot({ path: test.info().outputPath('media-failure.png') })
  await editor.locator('.seq-clip').first().click()
  const start = editor.getByRole('spinbutton', { name: '入点（秒）', exact: true })
  await start.fill('0.5')
  await start.blur()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  const time = await editor.locator('.seq-time').innerText()
  const read = () => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, sequence.id)
  const before = await read()
  const retry = editor.getByRole('button', { name: '重新加载预览', exact: true })
  await retry.click()
  await expect.poll(() => calls.filmstrip).toBe(2)
  await expect.poll(() => calls.peaks).toBe(2)
  await expect(editor.getByText('缩略图加载失败', { exact: true })).toBeVisible()
  fail = false
  await retry.click()
  await expect(editor.locator('.seq-filmstrip > span').first()).toBeVisible()
  await expect(editor.locator('.seq-wave path').first()).toBeVisible()
  await expect(editor.getByText('缩略图加载失败', { exact: true })).toHaveCount(0)
  await expect(editor.getByText('波形加载失败', { exact: true })).toHaveCount(0)
  await expect(editor.locator('.seq-time')).toHaveText(time)
  await expect
    .poll(() =>
      editor.locator('.seq-stage canvas[data-decoder]').evaluate((canvas: HTMLCanvasElement) => {
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
        for (let i = 0; i < data.length; i += 16)
          if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) > 40) return true
        return false
      }),
    )
    .toBe(true)
  await expect(start).toHaveValue('0.5')
  expect(await read()).toEqual(before)
})

test('三十分钟真实音频的完整峰值可显示和缩放，不使编辑器崩溃', async ({ page }) => {
  const longAudio = join(dir, 'long.flac')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=8000:duration=1800',
    '-c:a',
    'flac',
    longAudio,
  ])
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles([join(dir, shots[0]!), longAudio])
  await expect
    .poll(
      async () =>
        (await elements(page)).filter((e) => e.kind === 'video' || e.kind === 'audio').length,
    )
    .toBe(2)
  const all = await elements(page)
  const video = all.find((e) => e.kind === 'video')!
  const audio = all.find((e) => e.kind === 'audio')!
  await addNode(page, '序列', { x: 720, y: 800 })
  await page.keyboard.press('Escape')
  const sequence = (await elements(page)).find((e) => e.nodeType === 'plein/sequence')!
  await page.evaluate(
    ({ video, audio, sequence }) => {
      window.__plein.connect([video, 'video'], [sequence, 'clips'])
      window.__plein.connect([audio, 'audio'], [sequence, 'music'])
    },
    { video: video.id, audio: audio.id, sequence: sequence.id },
  )
  await zoomTo(page, [sequence.id])
  const at = await centerOf(page, sequence.id)
  const peaksResponse = page.waitForResponse(
    (response) => response.url().endsWith('/peaks') && response.ok(),
  )
  await page.mouse.dblclick(at.x, at.y)
  const peaks = (await (await peaksResponse).json()) as { rate: number; peaks: number[] }
  expect(peaks.rate).toBe(100)
  expect(peaks.peaks).toHaveLength(180_000)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const waveform = editor.locator('.seq-wave path')
  await expect
    .poll(async () => ({ errors, paths: await waveform.count() }))
    .toEqual({ errors: [], paths: 1 })
  const before = await waveform.getAttribute('d')
  await editor.getByRole('slider', { name: '缩放', exact: true }).press('End')
  await expect.poll(() => waveform.getAttribute('d')).not.toBe(before)
  expect((await waveform.getAttribute('d'))!.match(/M/g)!.length).toBeLessThanOrEqual(1200)
  await editor.getByRole('button', { name: '重新加载预览', exact: true }).click()
  await expect(waveform).toBeVisible()
  expect(errors).toEqual([])
})

for (const cancel of ['pointercancel', 'blur', 'Escape'] as const) {
  test(`时间线 ${cancel} 取消修剪和排序，不保存草稿且可继续拖动`, async ({ page }) => {
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传' }).click()
    await (await chooser).setFiles(shots.slice(0, 2).map((file) => join(dir, file)))
    await expect
      .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
      .toBe(2)
    const videos = (await elements(page)).filter((e) => e.kind === 'video')
    await addNode(page, '序列', { x: 720, y: 800 })
    await page.keyboard.press('Escape')
    const sequence = (await elements(page)).find((e) => e.nodeType === 'plein/sequence')!
    await page.evaluate(
      ({ videos, sequence }) => {
        for (const video of videos) window.__plein.connect([video.id, 'video'], [sequence, 'clips'])
      },
      { videos, sequence: sequence.id },
    )
    await zoomTo(page, [sequence.id])
    const at = await centerOf(page, sequence.id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const clips = editor.locator('.seq-clip')
    await expect(clips).toHaveCount(2)
    const read = () =>
      page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.clips, sequence.id)
    const before = await read()
    const cancelGesture = async () => {
      if (cancel === 'Escape') {
        await page.keyboard.press('Escape')
        // 不等待退场动画；松手不能把关闭前的草稿保存下来。
        await page.mouse.up()
        await expect(editor).toBeHidden()
        await page.mouse.dblclick(at.x, at.y)
        await expect(editor).toBeVisible()
        return
      }
      await page.evaluate((kind) => {
        window.dispatchEvent(
          kind === 'blur' ? new Event('blur') : new PointerEvent('pointercancel', { pointerId: 1 }),
        )
      }, cancel)
    }
    await clips.first().hover()
    const handle = (await clips.first().locator('.seq-trim-out').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 50, handle.y + handle.height / 2, { steps: 5 })
    await expect(editor.locator('[data-trimming]')).toHaveCount(1)
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 })))
    await expect(editor.locator('[data-trimming]')).toHaveCount(1)
    await cancelGesture()
    await expect(editor.locator('[data-trimming]')).toHaveCount(0)
    await page.mouse.move(handle.x - 80, handle.y + handle.height / 2)
    await page.mouse.up()
    expect(await read()).toEqual(before)
    await expect(editor.getByRole('spinbutton', { name: '出点（秒）', exact: true })).toHaveValue(
      '',
    )
    const order = () =>
      clips.evaluateAll((els) =>
        els
          .map((el) => ({ name: el.getAttribute('aria-label'), x: el.getBoundingClientRect().x }))
          .sort((a, b) => a.x - b.x)
          .map((el) => el.name),
      )
    const original = await order()
    const first = (await clips.first().boundingBox())!
    const second = (await clips.nth(1).boundingBox())!
    const drag = async () => {
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
      await page.mouse.down()
      await page.mouse.move(second.x + second.width - 12, first.y + first.height / 2, { steps: 8 })
    }
    await drag()
    await expect(editor.locator('[data-moving]')).toHaveCount(1)
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 })),
    )
    await expect(editor.locator('[data-moving]')).toHaveCount(1)
    await cancelGesture()
    await expect(editor.locator('[data-moving]')).toHaveCount(0)
    await page.mouse.up()
    expect(await read()).toEqual(before)
    await expect.poll(order).toEqual(original)
    await expect
      .poll(() =>
        clips.evaluateAll((els) => els.every((el) => getComputedStyle(el).transform === 'none')),
      )
      .toBe(true)
    await drag()
    await page.mouse.up()
    await expect.poll(order).toEqual([...original].reverse())
  })
}

/** 序列编辑器是多轨时间线：胶片条、波形，拖动换顺序，拖边缘修剪，空格播放 */
test('序列时间线：排序、修剪、播放', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles([...shots, 'line.wav', 'music.wav'].map((f) => join(dir, f)))
  const media = async () =>
    (await elements(page)).filter((e) => e.kind === 'video' || e.kind === 'audio')
  await expect.poll(async () => (await media()).length).toBe(5)
  await page.mouse.click(640, 120)
  await addNode(page, '序列', { x: 720, y: 800 })
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => (await elements(page)).some((e) => e.nodeType === 'plein/sequence'))
    .toBe(true)

  const all = await elements(page)
  const seq = all.find((e) => e.nodeType === 'plein/sequence')!
  const named = (name: string) => all.find((e) => e.name === name)!
  // 连线的拖拽在 editing.spec 里测过，这里直接写边：三段镜头、一条对白、配乐
  const edges: Array<[string, string, string]> = [
    ...shots.map((n) => [named(n).id, 'video', 'clips'] as [string, string, string]),
    [named('line.wav').id, 'audio', 'dialogue'],
    [named('music.wav').id, 'audio', 'music'],
  ]
  await page.evaluate(
    ([edges, to]) => {
      const doc = window.__plein.engine.doc as unknown as {
        edgeMap: { set(id: string, e: unknown): void }
      }
      edges.forEach(([from, port, input], i) =>
        doc.edgeMap.set(`edge-${i}`, { id: `edge-${i}`, from: [from, port], to: [to, input] }),
      )
    },
    [edges, seq.id] as const,
  )
  await expect.poll(async () => (await edgesInto(page, seq.id)).length).toBe(5)

  await zoomTo(page, [seq.id])
  const c = await centerOf(page, seq.id)
  await page.mouse.dblclick(c.x, c.y)
  const editor = page.getByRole('dialog', { name: '序列' })
  await expect(editor.getByText('3 段').first()).toBeVisible()
  const timeline = editor.getByRole('region', { name: '时间线' })
  const clips = timeline.locator('.seq-clip')
  await expect(clips).toHaveCount(3)
  // 胶片条和波形都画出来了
  await expect(clips.first().locator('.seq-filmstrip > span').first()).toBeVisible()
  await expect(timeline.locator('.seq-wave').first()).toBeVisible()
  const order = () => clips.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  // 时间线按位置排：读出从左到右的名字
  const leftToRight = () =>
    clips.evaluateAll((els) =>
      els
        .map((e) => ({ name: e.getAttribute('aria-label'), x: e.getBoundingClientRect().x }))
        .sort((a, b) => a.x - b.x)
        .map((e) => e.name),
    )
  const before = await leftToRight()
  expect(before).toHaveLength(3)
  if (shotDir) await editor.screenshot({ path: join(shotDir, 'timeline.png') })

  // 把第一段拖到最后
  const clip = (name: string | null) => timeline.locator(`.seq-clip[aria-label="${name}"]`)
  const first = clip(before[0]!)
  const box = (await first.boundingBox())!
  const lastBox = (await clip(before[2]!).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(lastBox.x + lastBox.width - 4, box.y + box.height / 2, { steps: 12 })
  if (shotDir) await editor.screenshot({ path: join(shotDir, 'timeline-dragging.png') })
  await page.mouse.up()
  await expect.poll(leftToRight).toEqual([before[1], before[2], before[0]])
  expect(await order()).toHaveLength(3)
  await expect(timeline).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('Space')
  await expect
    .poll(async () => (await editor.locator('.seq-time').textContent())?.slice(0, 6))
    .not.toBe('0:00.0')
  await page.keyboard.press('Space')

  // 拖出点把第一段剪短：检查器里出点跟着变
  const head = clip(before[1]!)
  // 等落下的滑动动画结束再量位置
  await expect
    .poll(() => clips.evaluateAll((els) => els.every((e) => !e.style.transform)))
    .toBe(true)
  await page.waitForTimeout(300)
  const hb = (await head.boundingBox())!
  await head.hover()
  const handle = head.locator('.seq-trim-out')
  await expect(handle).toBeVisible()
  await page.mouse.move(hb.x + hb.width - 3, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width * 0.6, hb.y + hb.height / 2, { steps: 8 })
  await page.mouse.up()
  const out = editor.getByRole('spinbutton', { name: '出点（秒）' })
  await expect(out).not.toHaveValue('')
  expect(Number(await out.inputValue())).toBeLessThan(2.5)

  // 修剪时播放头停在剪切处；Home 回到开头，空格播放，播放头往前走
  await expect(timeline).toBeFocused()
  const time = editor.locator('.seq-time')
  await expect(time).toHaveText(/^0:01\.\d \/ 0:06\.\d$/)
  await page.keyboard.press('Home')
  await expect(time).toHaveText(/^0:00\.0 \//)
  await page.keyboard.press('Space')
  await expect.poll(async () => (await time.textContent())?.slice(0, 6)).not.toBe('0:00.0')
  await page.keyboard.press('Space')
  if (shotDir) await editor.screenshot({ path: join(shotDir, 'timeline-trimmed.png') })

  // 预览画面由引擎解码画到画布上：暂停时也有画面，不是黑屏
  const screen = editor.locator('.seq-stage canvas').first()
  await expect(screen).toHaveAttribute('data-decoder', /\S/)
  await expect
    .poll(() =>
      screen.evaluate((c: HTMLCanvasElement) => {
        const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let lit = 0
        for (let i = 0; i < px.length; i += 4 * 97) if (px[i]! + px[i + 1]! + px[i + 2]! > 60) lit++
        return lit
      }),
    )
    .toBeGreaterThan(50)
  // 播放时画面跟着走（逐帧解码，不是停在一帧上）
  const snap = () => screen.evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png'))
  const still = await snap()
  await page.keyboard.press('Space')
  await expect.poll(snap).not.toBe(still)
  await page.keyboard.press('Space')

  // 字幕：预览用 libass（与导出同一个字体），没有中文字体的机器退回近似字幕；CI 装了 Noto CJK
  await page.keyboard.press('Home')
  const subtitle = editor.getByRole('textbox', { name: '字幕' })
  await subtitle.fill('雨夜，她终于回来了')
  await subtitle.press('Enter')
  const stage = editor.locator('.seq-stage')
  await expect(stage).not.toHaveAttribute('data-subtitles', 'loading')
  if (process.env.CI || process.env.PLEIN_SUBTITLE_FONT)
    await expect(stage).toHaveAttribute('data-subtitles', 'libass')
  await expect(timeline.locator('.seq-block-text').first()).toContainText('雨夜')
  if (shotDir) {
    await page.waitForTimeout(500)
    await editor.screenshot({ path: join(shotDir, 'subtitles.png') })
  }

  // 逐段设置：第二段转场改成推移、两倍速；时间线上出现转场标记，这段时长减半
  const second = clip((await leftToRight())[1]!)
  await second.click()
  const len = async () =>
    Number.parseFloat((await second.locator('.seq-clip-len').textContent())!.split('·').at(-1)!)
  const full = await len()
  await editor.getByRole('combobox', { name: '进入这段的转场' }).click()
  await page.getByRole('option', { name: '推移' }).click()
  await expect(timeline.locator('.seq-transition')).toHaveCount(1)
  await editor.getByRole('combobox', { name: '速度' }).click()
  await page.getByRole('option', { name: '2×' }).click()
  await expect(second.locator('.seq-clip-len')).toContainText('2×')
  expect(await len()).toBeCloseTo(full / 2, 1)
  // 配乐上画出对白时压低的音量线
  await expect(timeline.locator('.seq-envelope')).toBeVisible()
  // 停在推移中间：画布上左右两半来自不同的镜头
  const tr = (await timeline.locator('.seq-transition').boundingBox())!
  const ruler = (await timeline.locator('.seq-ruler').boundingBox())!
  await page.mouse.click(tr.x + tr.width / 2, ruler.y + ruler.height / 2)
  if (shotDir) {
    await page.waitForTimeout(400)
    await editor.screenshot({ path: join(shotDir, 'transition.png') })
  }

  // 语音识别是可选的；开启后能明确选择音频模型，并保存到序列参数。
  await editor.getByRole('button', { name: '成片', exact: true }).click()
  const asr = editor.getByRole('switch', { name: '按语音识别对齐字幕', exact: true })
  const model = editor.getByRole('button', { name: '模型', exact: true })
  await expect(model).toHaveCount(0)
  await asr.click()
  await model.click()
  const picker = page.getByRole('dialog', { name: '选择模型', exact: true })
  await expect(picker.getByRole('option')).toHaveCount(1)
  await picker.getByRole('option', { name: /Mock 音频/ }).click()
  await expect(model).toContainText('Mock 音频')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.model, seq.id),
  ).toBe('plein/mock:audio')
  const subtitles = editor.getByRole('switch', { name: '开启字幕', exact: true })
  await subtitles.click()
  await expect(model).toHaveCount(0)
  await expect(asr).toBeDisabled()
  await subtitles.click()
  await expect(model).toContainText('Mock 音频')
  await asr.click()
  await expect(model).toHaveCount(0)

  // 导出剪辑工程：下载一个 zip（OTIO / FCPXML / 字幕 / 素材）
  const download = page.waitForEvent('download')
  await editor.getByRole('button', { name: '导出工程' }).click()
  // 文件名是中文时 Playwright 自带的无头 Chromium 只给出 "download"，这里检查内容
  const zipped = readFileSync((await (await download).path())!)
  expect(zipped.subarray(0, 2).toString()).toBe('PK')
  expect(zipped.includes(Buffer.from('timeline.otio'))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
})

test(
  '字幕持久轨：全部对白、逐句编辑、工程一致与异步覆盖保护',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传' }).click()
    await (
      await chooser
    ).setFiles(['shot-c.webm', 'line.wav', 'music.wav'].map((name) => join(dir, name)))
    await expect
      .poll(
        async () =>
          (await elements(page)).filter((e) => e.kind === 'audio' || e.kind === 'video').length,
      )
      .toBe(3)
    const seq = await page.evaluate(() => {
      const all = [...window.__plein.engine.doc.elements()]
      const video = all.find((e) => e.name === 'shot-c.webm')!
      const d1 = all.find((e) => e.name === 'line.wav')!
      const d2 = all.find((e) => e.name === 'music.wav')!
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: '字幕回归',
        x: 800,
        y: 500,
        params: {
          model: 'plein/mock:audio',
          clips: [{ source: video.id, dialogue: d1.id, more: [d2.id] }],
        },
      })
      window.__plein.connect([video.id, 'video'], [id, 'clips'])
      window.__plein.connect([d1.id, 'audio'], [id, 'dialogue'])
      window.__plein.connect([d2.id, 'audio'], [id, 'dialogue'])
      return id
    })
    const open = async () => {
      await zoomTo(page, [seq])
      // 先选中：选中后节点编辑器会展开在卡片下方，画布布局跟着变，
      // 原来的坐标就偏了。选中后等位置稳住再重新取一次坐标双击。
      await clickElement(page, seq)
      await settle(page, seq)
      const point = await centerOf(page, seq)
      await page.mouse.dblclick(point.x, point.y)
      await page
        .getByRole('dialog', { name: '序列' })
        .getByRole('button', { name: '字幕', exact: true })
        .click()
    }
    await open()
    const editor = page.getByRole('dialog', { name: '序列' })
    const recognize = editor.getByRole('button', { name: '识别全部对白并重建字幕' })
    await expect(recognize).toBeEnabled()
    const response = page.waitForResponse(
      (r) => r.url().includes('/subtitle-recognize') && r.status() === 200,
    )
    await recognize.click()
    const recognized = (await (await response).json()) as { transcripts: Record<string, unknown> }
    expect(Object.keys(recognized.transcripts)).toHaveLength(2)
    const text = editor.getByRole('textbox', { name: '镜头 1 字幕 1 文本', exact: true })
    await expect(text).toBeVisible()
    await expect(editor.getByRole('textbox', { name: /镜头 1 字幕 \d 文本/ })).toHaveCount(4)
    await text.fill('人工修订的第一句')
    await editor.getByRole('spinbutton', { name: '镜头 1 字幕 1 开始（秒）' }).fill('0.25')
    await editor.getByRole('checkbox', { name: '显示字幕 2', exact: true }).uncheck()
    await expect(editor.locator('.seq-block-text')).toHaveCount(3)
    await expect(editor.locator('.seq-block-text').first()).toContainText('人工修订的第一句')
    const request = page.waitForRequest(
      (r) => r.url().endsWith('/sequence-export') && r.method() === 'POST',
    )
    const download = page.waitForEvent('download')
    await editor.getByRole('button', { name: '导出工程', exact: true }).click()
    const spec = (await request).postDataJSON().spec as {
      subtitles: { cues: Array<{ start: number; text: string }> }
    }
    expect(spec.subtitles.cues).toHaveLength(3)
    expect(spec.subtitles.cues[0]).toMatchObject({ start: 0.25, text: '人工修订的第一句' })
    expect(
      readFileSync((await (await download).path())!).includes(Buffer.from('subtitles.srt')),
    ).toBe(true)
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    await page.reload()
    await page.waitForFunction(() => !!window.__plein)
    await open()
    await expect(text).toHaveValue('人工修订的第一句')
    await expect(
      editor.getByRole('checkbox', { name: '显示字幕 2', exact: true }),
    ).not.toBeChecked()
    await page.evaluate((id) => {
      const doc = window.__plein.engine.doc
      const clips = doc.get(id)!.params!.clips as Array<Record<string, unknown>>
      const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
      params.set(
        'clips',
        clips.map((c) => ({ ...c, lineDelay: 0.25 })),
      )
    }, seq)
    await expect(editor.getByRole('button', { name: '导出工程', exact: true })).toBeDisabled()
    await expect(editor.getByText(/字幕已过期/).first()).toBeVisible()

    let release!: () => void
    let fetched!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      fetched = resolve
    })
    await page.route('**/api/media/subtitle-recognize', async (route) => {
      const result = await route.fetch()
      fetched()
      await gate
      await route.fulfill({ response: result })
    })
    await recognize.click()
    await ready
    await text.fill('识别等待期间继续编辑')
    release()
    await expect(editor.getByRole('alert')).toContainText('未覆盖编辑')
    await expect(text).toHaveValue('识别等待期间继续编辑')
    await expect(editor.getByRole('button', { name: '导出工程', exact: true })).toBeDisabled()
    await page.unroute('**/api/media/subtitle-recognize')
    // 未知状态的展示与显式恢复操作使用接口夹具；持久 journal/续查在服务端专项用真 host 验证。
    const recoveringAsset = Object.keys(recognized.transcripts)[0]!
    const recoveryInfo = {
      model: 'plein/mock:audio',
      assetId: recoveringAsset,
      expected: 'unknown-revision',
      recovery: { state: 'submit_unknown', attachable: true, note: '提交状态未知，请先在平台核查' },
    }
    await page.route('**/api/media/subtitle-recognition?**', (route) =>
      route.fulfill({
        json:
          new URL(route.request().url()).searchParams.get('assetId') === recoveringAsset
            ? recoveryInfo
            : null,
      }),
    )
    let recoveryBody: Record<string, unknown> | undefined
    let newRecognitions = 0
    await page.route('**/api/media/subtitle-recover', (route) => {
      recoveryBody = route.request().postDataJSON()
      return route.fulfill({ json: { ok: true } })
    })
    await page.route('**/api/media/subtitle-recognize', (route) => {
      newRecognitions++
      return route.fulfill({ json: recognized })
    })
    await page.reload()
    await page.waitForFunction(() => !!window.__plein)
    await open()
    const recoveryControls = editor.locator('[aria-label="字幕识别恢复"]')
    await expect(recoveryControls).toBeVisible()
    await expect(
      recoveryControls.getByRole('button', { name: '确认未受理，重新提交识别' }),
    ).toBeDisabled()
    expect(newRecognitions).toBe(0)
    await recoveryControls
      .getByRole('textbox', { name: '字幕识别平台任务 ID' })
      .fill('platform-asr-123')
    await recoveryControls.getByRole('button', { name: '关联任务并续查' }).click()
    await expect
      .poll(() => recoveryBody)
      .toMatchObject({
        expected: 'unknown-revision',
        operation: { action: 'attach', remoteId: 'platform-asr-123' },
      })
    await expect.poll(() => newRecognitions).toBe(1)
    await expect(editor.getByRole('button', { name: '导出工程', exact: true })).toBeEnabled()
  },
)

test('普通音频工具自定义切点与区间：预览后生成新素材，拒绝无效计划', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles(join(dir, 'music.wav'))
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'audio').length)
    .toBe(1)
  const audio = (await elements(page)).find((e) => e.kind === 'audio')!
  const requests: unknown[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/media/derive') && request.method() === 'POST')
      requests.push(request.postDataJSON())
  })
  const openTools = async () => {
    await page.keyboard.press('Escape')
    await zoomTo(page, [audio.id])
    const point = await centerOf(page, audio.id)
    await page.mouse.click(point.x, point.y)
    await page
      .getByRole('toolbar', { name: '结果操作' })
      .getByRole('button', { name: '媒体工具' })
      .click()
    await page.getByRole('button', { name: '手动切分' }).click()
  }
  await openTools()
  await page.getByRole('combobox', { name: '分段方式' }).selectOption('cuts')
  await page.getByRole('textbox', { name: '音频切点' }).fill('1.2, 4.5')
  await expect(page.locator('[aria-label="切分区间预览"]')).toContainText('将生成 3 段')
  await page.getByRole('button', { name: '开始加工' }).click()
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'audio').length)
    .toBe(4)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    op: 'split',
    segments: [
      { start: 0, end: 1.2 },
      { start: 1.2, end: 4.5 },
      { start: 4.5, end: 9 },
    ],
  })
  await openTools()
  await page.getByRole('combobox', { name: '分段方式' }).selectOption('ranges')
  await page.getByRole('textbox', { name: '音频区间' }).fill('0 - 1\n2 - 4')
  await expect(page.locator('[aria-label="切分区间预览"]')).toContainText('将生成 2 段')
  await page.getByRole('button', { name: '开始加工' }).click()
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'audio').length)
    .toBe(6)
  expect(requests).toHaveLength(2)
  await openTools()
  await page.getByRole('combobox', { name: '分段方式' }).selectOption('cuts')
  await page.getByRole('textbox', { name: '音频切点' }).fill('3, 1')
  await page.getByRole('button', { name: '开始加工' }).click()
  await expect(page.locator('.ui-toast')).toContainText('切点需严格递增')
  expect(requests).toHaveLength(2)
})

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
