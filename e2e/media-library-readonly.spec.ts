import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
for (const mode of ['changed', 'initial'] as const) {
  test(`素材库 ${mode} 只读状态明确停用放入，恢复后可放入并撤销`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const bytes = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=teal:s=160x96',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ])
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': 'permission-fixture.png' },
      data: bytes,
    })
    expect(response.status()).toBe(201)
    const assetId = ((await response.json()) as { id: string }).id
    await page.evaluate((initial) => {
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.undo.clear()
      engine.doc.readOnly = initial
      engine.refreshState()
    }, mode === 'initial')
    await page.getByRole('button', { name: '素材', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '素材', exact: true })
    await panel.getByRole('combobox', { name: '关联项目' }).click()
    await page.getByRole('option', { name: '全部项目', exact: true }).click()
    await panel.getByRole('searchbox', { name: '搜索素材', exact: true }).fill('permission-fixture')
    await panel
      .getByRole('button', { name: '查看素材 permission-fixture.png', exact: true })
      .click()
    const place = panel.getByRole('button', { name: '放入当前画布', exact: true })
    if (mode === 'changed') {
      await expect(place).toBeEnabled()
      await page.evaluate(() => {
        const engine = window.__plein.engine as unknown as Engine
        engine.doc.readOnly = true
        engine.refreshState()
      })
    }
    await expect(place).toBeDisabled()
    await expect(place).toHaveAttribute('title', /只读/)
    await expect(place).toHaveAccessibleDescription(/只读/)
    await expect(panel.getByRole('status').filter({ hasText: '当前画布为只读' })).toBeVisible()
    await panel.getByRole('button', { name: '放大查看素材', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '素材预览', exact: true })
    await expect(
      preview.getByRole('img', { name: 'permission-fixture.png', exact: true }),
    ).toHaveAttribute('src', `/api/assets/${assetId}`)
    await preview.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(preview).toHaveCount(0)
    const box = (await place.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual([])
    await panel.screenshot({ path: test.info().outputPath('media-readonly.png') })
    await page.evaluate(() => {
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.readOnly = false
      engine.refreshState()
    })
    await expect(place).toBeEnabled()
    await place.click()
    await expect(panel).toHaveCount(0)
    expect(
      await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((el) => el.assetId)),
    ).toEqual([assetId])
    await page.evaluate(() => (window.__plein.engine as unknown as Engine).undo())
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual([])
    await page.evaluate(() => (window.__plein.engine as unknown as Engine).redo())
    expect(
      await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((el) => el.assetId)),
    ).toEqual([assetId])
    expect(errors).toEqual([])
  })
}
