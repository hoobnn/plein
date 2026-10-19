import { expect, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { clickElement, newProject, waitEngine, waitNode } from './canvas'

test('同一图片用于两个首尾帧来源时，预览顺序、重绘和实际生成都保留两帧', async ({ page }) => {
  const duplicateKeys: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('same key'))
      duplicateKeys.push(message.text())
  })
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles(
    ['循环开场', '循环结束'].map((name) => ({
      name: `${name}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(solidPng(64, 48, [50, 100, 160])),
    })),
  )
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    )
    .toBe(2)
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => el.kind === 'image')
          .map((el) => el.name)
          .sort((a, b) => (a ?? '').localeCompare(b ?? '')),
      ),
    )
    .toEqual(['循环开场.png', '循环结束.png'])
  const { id, asset } = await page.evaluate(() => {
    const images = [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image')
    const first = images.find((el) => el.name?.includes('循环开场'))!
    const last = images.find((el) => el.name?.includes('循环结束'))!
    const video = window.__plein.addNode({
      type: 'plein/video',
      name: '相同首尾帧',
      x: 400,
      y: 200,
      params: { model: 'plein/mock:video', mode: 'frames', prompt: '绕水杯一周回到原处' },
    })
    window.__plein.connect([first.id, 'image'], [video, 'images'])
    window.__plein.connect([last.id, 'image'], [video, 'images'])
    return { id: video, asset: first.assetId }
  })
  await clickElement(page, id)
  const preview = page.getByTestId('input-preview')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  const frames = preview.locator('figure')
  await expect(frames).toHaveCount(2)
  await expect(frames.nth(0)).toContainText('循环开场')
  await expect(frames.nth(1)).toContainText('循环结束')
  expect(duplicateKeys).toEqual([])
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(frames).toHaveCount(2)
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const input = await (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).json()
  expect(input.inputs.images.map((v: { assetId: string }) => v.assetId)).toEqual([asset, asset])
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, id)
  await expect(preview).toHaveAttribute('aria-busy', 'false')
  await expect(frames).toHaveCount(2)
  await expect(frames.nth(0)).toContainText('循环开场')
  await expect(frames.nth(1)).toContainText('循环结束')
  expect(duplicateKeys).toEqual([])
  await frames.first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await expect(frames.nth(0)).toBeInViewport({ ratio: 1 })
  await expect(frames.nth(1)).toBeInViewport({ ratio: 1 })
  for (const frame of await frames.all())
    await expect
      .poll(() =>
        frame.evaluate((el) => {
          const rect = el.getBoundingClientRect()
          return [rect.top + 2, rect.bottom - 2].every((y) =>
            el.contains(document.elementFromPoint(rect.left + rect.width / 2, y)),
          )
        }),
      )
      .toBe(true)
  await page.screenshot({ path: test.info().outputPath('shared-frame-input.png') })
  await page.reload()
  await waitEngine(page)
  await clickElement(page, id)
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(frames).toHaveCount(2)
  await expect(frames.nth(0)).toContainText('循环开场')
  await expect(frames.nth(1)).toContainText('循环结束')
  expect(duplicateKeys).toEqual([])
})
