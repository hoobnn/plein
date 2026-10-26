import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'
let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-p2-video-'))
  for (const [name, color, frequency, size] of [
    ['source', 'blue', '440', '160x90'],
    ['candidate', 'red', '880', '90x120'],
  ])
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${size}:r=10:d=2`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=2`,
      ...(name === 'source' ? ['-vf', 'drawbox=x=40:y=30:w=32:h=20:color=white:t=fill'] : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, `${name}.mp4`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))
async function fixture(page: Page) {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles([join(dir, 'source.mp4'), join(dir, 'candidate.mp4')])
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'video').length,
      ),
    )
    .toBe(2)
  return page.evaluate(() =>
    Object.fromEntries(
      [...window.__plein.engine.doc.elements()]
        .filter((el) => el.kind === 'video')
        .map((el) => [el.name!.split('.')[0], { id: el.id, assetId: el.assetId! }]),
    ),
  )
}
async function tools(page: Page, id: string) {
  await page.keyboard.press('Escape')
  await zoomTo(page, [id])
  const p = await centerOf(page, id)
  await page.mouse.click(p.x, p.y)
  await page
    .getByRole('toolbar', { name: '结果操作' })
    .getByRole('button', { name: '媒体工具', exact: true })
    .click()
  return page.getByRole('dialog', { name: '媒体工具', exact: true })
}
const videos = (page: Page) =>
  page.evaluate(() => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'video'))

test('区域修补与片段替换保留来源；无效帧边界保留填写，可修正后生成', async ({ page }) => {
  const ids = await fixture(page)
  const submissions: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/(run|run-flow|run-batch)$/.test(new URL(r.url()).pathname))
      submissions.push(r.url())
  })
  let menu = await tools(page, ids.source!.id)
  await menu.getByRole('button', { name: '区域修补（本地插值）', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '区域修补（本地插值）', exact: true })
  for (const [label, value] of [
    ['左侧像素', '40'],
    ['顶部像素', '30'],
    ['区域宽度', '32'],
    ['区域高度', '20'],
    ['原视频入点（秒）', '0.5'],
    ['原视频出点（秒）', '1.5'],
  ])
    await dialog.getByLabel(label!).fill(value!)
  await expect(dialog.getByLabel('修补区域预览')).toBeVisible()
  await dialog.getByRole('button', { name: '生成新视频', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await videos(page)).length).toBe(3)
  let derived = (await videos(page)).find((el) => el.params?.mediaDerivation)!
  expect(derived.params!.mediaDerivation).toMatchObject({
    version: 1,
    op: 'repair-region',
    source: { assetId: ids.source!.assetId },
    params: { left: 40, top: 30, start: 0.5, end: 1.5 },
  })
  menu = await tools(page, ids.source!.id)
  await menu.getByRole('button', { name: '片段替换', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '片段替换', exact: true })
  await dialog.getByRole('combobox', { name: '替换素材' }).click()
  await page.getByRole('option', { name: /^candidate.mp4/ }).click()
  await dialog.getByLabel('原视频入点（秒）').fill('0.5')
  await dialog.getByLabel('原视频出点（秒）').fill('1.55')
  await dialog.getByLabel('替换素材起点（秒）').fill('0.2')
  await dialog.getByRole('button', { name: '生成新视频', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('帧边界')
  await expect(dialog.getByLabel('原视频出点（秒）')).toHaveValue('1.55')
  expect(await videos(page)).toHaveLength(3)
  await dialog.getByLabel('原视频出点（秒）').fill('1.5')
  await dialog.screenshot({ path: test.info().outputPath('replace-range.png') })
  await dialog.getByRole('button', { name: '生成新视频', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await videos(page)).length).toBe(4)
  derived = (await videos(page)).find(
    (el) => (el.params?.mediaDerivation as { op: string } | undefined)?.op === 'replace-range',
  )!
  expect(derived.params!.mediaDerivation).toMatchObject({
    source: { assetId: ids.source!.assetId },
    params: { replacementAssetId: ids.candidate!.assetId, start: 0.5, end: 1.5, audio: 'source' },
  })
  expect((await videos(page)).find((el) => el.id === ids.source!.id)!.assetId).toBe(
    ids.source!.assetId,
  )
  expect(submissions).toEqual([])
})

test('确认前替换素材改变文件时必须重新选择，不发出加工请求', async ({ page }) => {
  const ids = await fixture(page)
  const menu = await tools(page, ids.source!.id)
  await menu.getByRole('button', { name: '片段替换', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '片段替换', exact: true })
  await dialog.getByRole('combobox', { name: '替换素材' }).click()
  await page.getByRole('option', { name: /^candidate.mp4/ }).click()
  let requests = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/media/derive')) requests++
  })
  await page.evaluate(
    ({ id, asset }) => {
      const map = window.__plein.engine.doc.mutable(id) as unknown as {
        set(key: string, value: unknown): void
      }
      map.set('assetId', asset)
    },
    { id: ids.candidate!.id, asset: ids.source!.assetId },
  )
  await expect(dialog.getByRole('alert')).toContainText('替换素材已变化')
  await expect(dialog.getByRole('button', { name: '生成新视频', exact: true })).toBeDisabled()
  expect(requests).toBe(0)
  expect(await videos(page)).toHaveLength(2)
})
