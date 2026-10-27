import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { addNode, centerOf, clickElement, edgesInto, elements, newProject, zoomTo } from './canvas'

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
    'color=c=red:s=96x64:d=1:r=8',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=96x64:d=1:r=8',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'cut.mp4'),
  )
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

  // 导出剪辑工程：下载一个 zip（OTIO / FCPXML / 字幕 / 素材）
  const download = page.waitForEvent('download')
  await editor.getByRole('button', { name: '导出工程' }).click()
  // 文件名是中文时 Playwright 自带的无头 Chromium 只给出 "download"，这里检查内容
  const zipped = readFileSync((await (await download).path())!)
  expect(zipped.subarray(0, 2).toString()).toBe('PK')
  expect(zipped.includes(Buffer.from('timeline.otio'))).toBe(true)
  expect(zipped.includes(Buffer.from('timeline.fcpxml'))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
  // 重载后剪辑与服务端文档一致；有结果的序列仍进入编辑，独立播放器及时释放。
  const saved = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, seq.id)
  await page.reload()
  await page.waitForFunction(() => !!window.__plein)
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params, seq.id))
    .toEqual(saved)
  await zoomTo(page, [seq.id])
  await page.evaluate(
    ({ id, source }) => {
      const doc = window.__plein.engine.doc
      const mutable = doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }
      mutable.set('results', [
        {
          id: 'existing-film',
          runId: 'fixture',
          port: 'video',
          at: 1,
          value: { type: 'video', assetId: doc.get(source)!.assetId },
        },
      ])
    },
    { id: seq.id, source: named(shots[0]!).id },
  )
  await page.getByRole('button', { name: '播放成片', exact: true }).click()
  const playerMedia = page.locator('[data-player-el] video')
  await expect
    .poll(() => playerMedia.evaluate((video: HTMLVideoElement) => !video.paused))
    .toBe(true)
  const playerHandle = await playerMedia.elementHandle()
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), seq.id)
  await page
    .getByTestId('generator')
    .getByRole('button', { name: /^编辑序列/ })
    .press('Enter')
  await expect(editor).toBeVisible()
  await expect(page.locator('[data-player-el]')).toHaveCount(0)
  expect(
    await playerHandle!.evaluate(
      (video: HTMLVideoElement) => video.paused && !video.getAttribute('src') && !video.isConnected,
    ),
  ).toBe(true)
  await playerHandle!.dispose()
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
})

async function open(page: Page, id: string) {
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toHaveCSS('opacity', '1')
  return editor
}

test(
  '真实视频快速播放暂停与连续定位，暂停画面始终落在最终位置',
  { tag: '@core' },
  async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles(join(dir, 'cut.mp4'))
    await expect
      .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
      .toBe(1)
    const video = (await elements(page)).find((e) => e.kind === 'video')!
    const id = await page.evaluate((source) => {
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: '暂停定位画面',
        x: 3000,
        y: 1000,
        params: { subtitles: false, aspectRatio: '16:9', clipVolume: 0 },
      })
      window.__plein.connect([source, 'video'], [id, 'clips'])
      return id
    }, video.id)
    const editor = await open(page, id)
    const monitor = editor.locator('.seq-monitor')
    const canvas = monitor.locator('.seq-stage > canvas')
    const color = () =>
      canvas.evaluate((canvas: HTMLCanvasElement) => {
        const p = canvas
          .getContext('2d')!
          .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
        return p[0]! > 150 && p[2]! < 80 ? 'red' : p[2]! > 150 && p[0]! < 80 ? 'blue' : 'other'
      })
    await expect.poll(color).toBe('red')
    for (let i = 0; i < 1; i++) {
      await monitor.getByRole('button', { name: '播放', exact: true }).click()
      await monitor.getByRole('button', { name: '暂停', exact: true }).click()
      await monitor.getByRole('button', { name: '回到开头', exact: true }).click()
      for (const key of ['Shift+ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight'])
        await page.keyboard.press(key)
      await expect(monitor.locator('.seq-time > span').first()).toHaveText('0:01.0')
      await expect.poll(color).toBe('blue')
      if (i === 0)
        await monitor.screenshot({ path: test.info().outputPath('paused-blue-position.png') })
      await page.keyboard.press('Shift+ArrowLeft')
      await expect.poll(color).toBe('red')
      await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    }
    await expect(canvas).toHaveAttribute('data-decoder', 'webcodecs')
    expect(errors).toEqual([])
  },
)
