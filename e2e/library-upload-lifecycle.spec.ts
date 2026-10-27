import { openLibraryPanel } from './library-ui'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-library-upload-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=64x64',
    '-frames:v',
    '1',
    join(dir, 'reference.png'),
  ])
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=64x64:d=0.4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'reference.mp4'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const scenario of [
  { kind: 'scene', label: '场景', slot: '主场景图', media: 'image' },
  { kind: 'effect', label: '特效', slot: '参考视频', media: 'video' },
] as const) {
  test(`${scenario.label}${scenario.slot}上传中保护保存和导航，失败可恢复且不漏存素材`, async ({
    page,
  }) => {
    if (scenario.media === 'video') await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    await openLibraryPanel(page)
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel
      .getByRole('group', { name: '资产类别', exact: true })
      .getByRole('button', { name: scenario.label, exact: true })
      .click()
    await panel
      .getByRole('button', { name: `新建${scenario.label}`, exact: true })
      .first()
      .click()
    const name = `${scenario.label}${scenario.slot}上传回归`
    await panel.getByRole('textbox', { name: '名称', exact: true }).fill(name)
    const field = panel
      .locator('.ui-field')
      .filter({ has: page.locator('.ui-label').filter({ hasText: scenario.slot }) })
      .last()
    const save = panel.getByRole('button', { name: '保存', exact: true })
    let finish!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const uploading = new Promise<void>((resolve) => {
      started = resolve
    })
    let uploadId = ''
    await page.route('**/api/assets', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      expect(response.status()).toBe(201)
      uploadId = (await response.json()).id
      started()
      await gate
      await route.fulfill({ response })
    })
    const upload = async () => {
      const chooser = page.waitForEvent('filechooser')
      await field
        .getByRole('button', {
          name: scenario.media === 'video' ? '上传视频' : '上传',
          exact: true,
        })
        .click()
      await (
        await chooser
      ).setFiles(join(dir, `reference.${scenario.media === 'video' ? 'mp4' : 'png'}`))
    }
    await upload()
    await uploading
    try {
      await expect(save).toBeDisabled()
      await expect(panel.getByRole('button', { name: /添加到画布$/ })).toBeDisabled()
      await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toBeDisabled()
      await expect(panel.getByRole('button', { name: '返回', exact: true })).toBeDisabled()
      await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeDisabled()
      await expect(
        panel
          .getByRole('group', { name: '资产类别' })
          .getByRole('button', { name: '角色', exact: true }),
      ).toBeDisabled()
      await expect(panel.getByRole('status')).toContainText('上传中')
      await page.keyboard.press('Escape')
      await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(name)
      await expect(panel).toBeVisible()
      if (scenario.media === 'video')
        await panel.screenshot({
          path: test.info().outputPath('video-upload-pending.png'),
          animations: 'disabled',
        })
    } finally {
      finish()
    }
    await expect(panel.getByRole('status')).toHaveCount(0)
    await expect
      .poll(() =>
        field
          .locator(scenario.media === 'video' ? 'video' : 'img')
          .evaluate((element) =>
            element instanceof HTMLVideoElement
              ? element.readyState >= 2 && element.videoWidth > 0
              : (element as HTMLImageElement).complete &&
                (element as HTMLImageElement).naturalWidth > 0,
          ),
      )
      .toBe(true)
    await expect(save).toBeEnabled()
    await save.click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    const items = await (await page.request.get('/api/library')).json()
    const item = items.find((entry: { name: string }) => entry.name === name)
    expect(item).toBeTruthy()
    expect(scenario.media === 'video' ? item.video : item.images[0].assetId).toBe(uploadId)
    expect(item.kind).toBe(scenario.kind)
    await field.getByRole('button', { name: '移除', exact: true }).click()
    await page.route(
      '**/api/assets',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: '素材上传暂不可用' }),
        }),
      { times: 1 },
    )
    await upload()
    await expect(panel.getByText('素材上传暂不可用', { exact: true })).toBeVisible()
    await expect(panel.getByRole('status')).toHaveCount(0)
    await expect(save).toBeEnabled()
    await expect(panel.getByRole('button', { name: '返回', exact: true })).toBeEnabled()
    await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeEnabled()
    await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(name)
    const unchanged = await (await page.request.get(`/api/library/${item.id}`)).json()
    expect(scenario.media === 'video' ? unchanged.video : unchanged.images[0].assetId).toBe(
      uploadId,
    )
    await upload()
    await expect(field.locator(scenario.media === 'video' ? 'video' : 'img')).toBeVisible()
    await expect(panel.getByRole('status')).toHaveCount(0)
    // 同文件重试返回相同素材 ID；重新添加后草稿可能已经与保存版本相同。
    const currentSave = panel.getByRole('button', { name: '保存', exact: true })
    if (await currentSave.count()) {
      await currentSave.click()
      await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    }
    const finalItems = await (await page.request.get('/api/library')).json()
    expect(finalItems.filter((entry: { name: string }) => entry.name === name)).toEqual([
      expect.objectContaining({ id: item.id }),
    ])
  })
}
