import { expect, test } from './fixtures'
import { newProject, waitNode } from './canvas'
import { article, panel } from './checkpoints'

for (const media of [false, true]) {
  test(`${media ? '图片' : '文本'}检查点反复切换关闭和恢复时不销毁仍在使用的渲染资源`, async ({
    page,
  }) => {
    const warnings: string[] = [],
      errors: string[] = []
    page.on('console', (message) => {
      if (
        message.type() === 'warning' &&
        /BindGroup|destroyed while still bound/.test(message.text())
      )
        warnings.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const nodeId = await page.evaluate(
      (media) =>
        window.__plein.addNode({
          type: media ? 'plein/image' : 'plein/text',
          name: '纹理生命周期原稿',
          x: 0,
          y: 0,
          params: media
            ? { prompt: '海边的白色海鸟', model: 'plein/mock:image' }
            : { text: '纹理生命周期正文' },
        }),
      media,
    )
    const originalId = decodeURIComponent(page.url().split('#/c/')[1]!)
    if (media) {
      await expect
        .poll(async () =>
          (
            await page.request.post(`/api/canvases/${originalId}/nodes/${nodeId}/run`, { data: {} })
          ).status(),
        )
        .toBe(202)
      await waitNode(page, nodeId)
    }
    await page.getByRole('button', { name: '检查点', exact: true }).click()
    for (const name of ['资源第一版', '资源第二版']) {
      if (name === '资源第二版')
        await page.evaluate((id) => {
          ;(
            window.__plein.engine.doc.mutable(id)!.get('params') as {
              set(key: string, value: string): void
            }
          ).set('description', '第二版的设定变更')
        }, nodeId)
      await panel(page).getByRole('textbox', { name: '检查点名称', exact: true }).fill(name)
      await panel(page).getByRole('button', { name: '保存当前画布', exact: true }).click()
      await expect(article(page, name)).toBeVisible()
      await expect(
        panel(page)
          .getByTestId('checkpoint-preview')
          .getByRole('button', { name: '适应画布', exact: true }),
      ).toBeEnabled()
    }
    const original = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
    for (let i = 0; i < 2; i++) {
      for (const name of ['资源第一版', '资源第二版']) {
        await article(page, name).getByRole('button', { name: '只读预览', exact: true }).click()
        await expect(
          panel(page)
            .getByTestId('checkpoint-preview')
            .getByRole('button', { name: '适应画布', exact: true }),
        ).toBeEnabled()
      }
      await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
      await expect(panel(page)).toHaveCount(0)
      await page.evaluate(() => window.__plein.engine.zoomToFit())
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(original)
      await page.getByRole('button', { name: '检查点', exact: true }).click()
    }
    await article(page, '资源第一版')
      .getByRole('button', { name: '恢复为新画布', exact: true })
      .click()
    await expect(page).not.toHaveURL(new RegExp(originalId))
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...(window.__plein?.engine.doc.elements() ?? [])].some(
            (node) => node.name === '纹理生命周期原稿',
          ),
        ),
      )
      .toBe(true)
    await page.evaluate(() => window.__plein.engine.zoomToFit())
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    if (media) {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const { stats } = window.__plein.engine as Window['__plein']['engine'] & {
              stats: {
                previews: { ready: number }
                previewRevision: number
                renderedPreviewRevision: number
              }
            }
            return (
              stats.previews.ready > 0 && stats.previewRevision === stats.renderedPreviewRevision
            )
          }),
        )
        .toBe(true)
      await page.screenshot({
        path: test.info().outputPath('restored-texture.png'),
        animations: 'disabled',
      })
    }
    expect(errors).toEqual([])
    expect(warnings.slice(0, 1)).toEqual([])
  })
}
