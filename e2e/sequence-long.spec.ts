import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'

test('三十分钟时间线可铺满、定位和放大，片尾修剪与实际导出一致', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'plein-long-timeline-'))
  try {
    const file = join(dir, 'long.webm')
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32:d=1800:r=1',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      file,
    ])
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传' }).click()
    await (await chooser).setFiles(file)
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
    await expect(editor.locator('.seq-time')).toContainText('/ 30:00.0')
    const fits = () =>
      editor.locator('.seq-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 2)
    await expect.poll(fits).toBe(true)
    await editor.screenshot({ path: test.info().outputPath('long-fit.png') })
    await editor.getByRole('slider', { name: '缩放', exact: true }).press('End')
    await expect
      .poll(() => editor.locator('.seq-scroll').evaluate((el) => el.scrollWidth / el.clientWidth))
      .toBeGreaterThan(100)
    await editor.getByRole('slider', { name: '缩放', exact: true }).blur()
    const scroll = (await editor.locator('.seq-scroll').boundingBox())!
    const ruler = (await editor.locator('.seq-ruler').boundingBox())!
    await page.mouse.click(scroll.x + scroll.width - 12, ruler.y + ruler.height / 2)
    // 点选可见刻度时播放头应留在附近，不能突然把整屏卷到左端。
    await expect
      .poll(async () => (await editor.locator('.seq-playhead-grip').boundingBox())!.x)
      .toBeGreaterThan(scroll.x + scroll.width / 2)
    await page.keyboard.press('End')
    await expect(editor.locator('.seq-time')).toHaveText('30:00.0 / 30:00.0')
    await expect(editor.locator('.seq-playhead-grip')).toBeInViewport()
    await page.keyboard.press('Home')
    await expect(editor.locator('.seq-time')).toHaveText('0:00.0 / 30:00.0')
    await expect(editor.locator('.seq-playhead-grip')).toBeInViewport()
    await editor.getByRole('button', { name: '铺满', exact: true }).click()
    await expect.poll(fits).toBe(true)
    await page.keyboard.press('End')
    await expect(editor.locator('.seq-time')).toHaveText('30:00.0 / 30:00.0')
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
    await editor.getByRole('button', { name: '播放', exact: true }).click()
    await expect(editor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await expect(editor.locator('.seq-time')).toHaveText('30:00.0 / 30:00.0')
    await editor.locator('.seq-clip').first().click()
    const start = editor.getByRole('spinbutton', { name: '入点（秒）', exact: true })
    await start.fill('1799')
    await start.blur()
    await expect(start).toHaveValue('1799')
    await page.keyboard.press('Home')
    await expect(editor.locator('.seq-time')).toHaveText('0:00.0 / 0:01.0')
    await editor.getByRole('button', { name: '导出 MP4', exact: true }).click()
    const exported = editor.getByLabel('实际导出 MP4', { exact: true })
    await expect(exported).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => exported.evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration)))
      .toBe(true)
    const length = await exported.evaluate((v: HTMLVideoElement) => v.duration)
    expect(length).toBeGreaterThanOrEqual(1)
    expect(length).toBeLessThan(1.1)
    expect(errors).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
