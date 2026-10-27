import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { elements, newProject, waitEngine } from './canvas'

let dir = ''
const files = () => ['still.png', 'clip.mp4', 'voice.wav', 'notes.md'].map((f) => join(dir, f))

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-media-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  ff('-f', 'lavfi', '-i', 'color=c=orange:s=64x48', '-frames:v', '1', join(dir, 'still.png'))
  ff('-f', 'lavfi', '-i', 'testsrc=s=96x160:d=1:r=10', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4'))
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=1', join(dir, 'voice.wav'))
  writeFileSync(join(dir, 'notes.md'), '# 角色小传\n\n林晚，二十岁。\n')
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

// 真实文件选择 → 真实上传 → 服务端入库 → 刷新后仍在，只有浏览器能证明这一整条链。
test('导入图片、视频、音频、Markdown，刷新后都还在', { tag: '@core' }, async ({ page }) => {
  await newProject(page)

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传' }).click()
  await (await chooser).setFiles(files())

  const kinds = async () =>
    (await elements(page))
      .filter((e) => ['image', 'video', 'audio', 'markdown'].includes(e.kind))
      .map((e) => e.kind)
      .sort()
  await expect.poll(kinds).toEqual(['audio', 'image', 'markdown', 'video'])

  // 媒体进了资产库：元素指向的资产能读到元信息。
  const assetIds = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].flatMap((e) => (e.assetId ? [e.assetId] : [])),
  )
  expect(assetIds).toHaveLength(3)
  for (const id of assetIds)
    expect((await page.request.get(`/api/assets/${id}/meta`)).ok()).toBe(true)

  await page.reload()
  await waitEngine(page)
  await expect.poll(kinds).toEqual(['audio', 'image', 'markdown', 'video'])
})
