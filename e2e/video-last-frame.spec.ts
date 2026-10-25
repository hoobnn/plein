import { expect, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { clickElement, newProject, waitEngine, waitNode } from './canvas'

test('仅尾帧可以从模式菜单选择、预览实际用途、生成并在刷新后保留', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles({
    name: '指定结束画面.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(256, 256, [50, 100, 160])),
  })
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    )
    .toBe(1)
  const id = await page.evaluate(() => {
    const image = [...window.__plein.engine.doc.elements()].find((el) => el.kind === 'image')!
    const video = window.__plein.addNode({
      type: 'plein/video',
      name: '尾帧验收',
      x: 400,
      y: 200,
      params: { model: 'plein/mock:video', mode: 'image', prompt: '镜头以指定画面结束' },
    })
    window.__plein.connect([image.id, 'image'], [video, 'images'])
    return video
  })
  await clickElement(page, id)
  const generator = page.getByTestId('generator')
  const expand = generator.getByRole('button', { name: /^编辑/ })
  if (await expand.isVisible()) await expand.click()
  const mode = generator.getByRole('button', { name: '生成模式', exact: true })
  await mode.click()
  const option = page.getByRole('option').filter({ hasText: '仅尾帧' })
  await expect(option).toBeVisible()
  await expect(option).toContainText('连入 1 张图作尾帧')
  await page.screenshot({ path: test.info().outputPath('last-frame-mode-menu.png') })
  await option.click()
  await expect(mode).toContainText('仅尾帧')
  await expect(generator.getByText('尾帧', { exact: true })).toBeVisible()
  const preview = page.getByTestId('input-preview')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(preview.locator('.ui-chip').filter({ hasText: '生成模式' })).toHaveText(
    '生成模式 仅尾帧',
  )
  const generate = generator.getByRole('button', { name: '生成', exact: true })
  await expect(generate).toBeEnabled()
  await generate.click()
  await waitNode(page, id)
  await expect(preview).toHaveAttribute('aria-busy', 'false')
  await page.screenshot({ path: test.info().outputPath('last-frame-generated.png') })
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const jobs = await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()
  expect(jobs.jobs[0].input.params.mode).toBe('lastFrame')
  expect(jobs.jobs[0].input.inputs.images).toHaveLength(1)
  await page.reload()
  await waitEngine(page)
  await clickElement(page, id)
  await expect(mode).toContainText('仅尾帧')
})
