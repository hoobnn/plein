import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { centerOf, elements, newProject, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-readonly-sequence-'))
  for (const color of ['red', 'blue'])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=96x64:d=2:r=8`,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      join(dir, `${color}.webm`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function setup(page: Page) {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(['red', 'blue'].map((color) => join(dir, `${color}.webm`)))
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
    .toBe(2)
  const id = await page.evaluate(() => {
    const videos = [...window.__plein.engine.doc.elements()].filter((e) => e.kind === 'video')
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '只读剪辑',
      x: 700,
      y: 300,
      params: { subtitles: false, aspectRatio: '16:9' },
    })
    for (const video of videos) window.__plein.connect([video.id, 'video'], [id, 'clips'])
    return id
  })
  await zoomTo(page, [id])
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor.locator('.seq-trim-in')).toHaveCount(2)
  return {
    id,
    editor,
    original: await page.evaluate(() => [...window.__plein.engine.doc.elements()]),
  }
}

async function readonly(page: Page, value: boolean) {
  await page.evaluate((value) => {
    const doc = window.__plein.engine.doc as unknown as {
      readOnly: boolean
      pendingState: boolean
      requestFlush(): void
    }
    doc.readOnly = value
    // 与协作升级切只读一样发出状态通知，界面才会立即重绘
    doc.pendingState = true
    doc.requestFlush()
  }, value)
}

test('视频序列只读后隐藏修剪入口，拖动不排序但仍可定位', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await setup(page)
  await readonly(page, true)
  await f.editor.getByRole('button', { name: '成片', exact: true }).click()
  await expect(f.editor.getByRole('switch', { name: '开启字幕', exact: true })).toBeDisabled()
  await expect(f.editor.locator('.seq-trim')).toHaveCount(0)
  await expect(f.editor.getByRole('button', { name: '导出 MP4', exact: true })).toBeDisabled()
  const clips = f.editor.locator('.seq-clip')
  const a = (await clips.first().boundingBox())!
  const b = (await clips.nth(1).boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - 10, b.y + b.height / 2, { steps: 6 })
  await page.mouse.up()
  await clips.nth(1).click()
  await expect(f.editor.locator('.seq-time')).toContainText('0:02.0')
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  expect(errors).toEqual([])
})

test('视频修剪中转为只读取消草稿，恢复可写后可重新修剪', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await setup(page)
  const clip = f.editor.locator('.seq-clip').first()
  const handle = (await clip.locator('.seq-trim-in').boundingBox())!
  const x = handle.x + handle.width / 2,
    y = handle.y + handle.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 30, y, { steps: 4 })
  await readonly(page, true)
  await page.mouse.move(x + 50, y, { steps: 3 })
  await page.mouse.up()
  await expect(f.editor.locator('.seq-trim')).toHaveCount(0)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  await readonly(page, false)
  await f.editor.getByRole('button', { name: '成片', exact: true }).click()
  await expect(f.editor.locator('.seq-trim-in')).toHaveCount(2)
  const fresh = (await clip.locator('.seq-trim-in').boundingBox())!
  await page.mouse.move(fresh.x + fresh.width / 2, fresh.y + fresh.height / 2)
  await page.mouse.down()
  await page.mouse.move(fresh.x + 30, fresh.y + fresh.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(async () => {
      const params = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, f.id)
      return (params!.clips as Array<{ in: number }>)[0]?.in ?? 0
    })
    .toBeGreaterThan(0)
  expect(errors).toEqual([])
})
