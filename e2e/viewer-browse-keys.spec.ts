import { expect, test } from '@playwright/test'
import { newProject, waitNode } from './canvas'

for (const mode of [
  'removed',
  'inserted',
  'rapid',
  'modifiers',
  'composing',
  'controls',
] as const) {
  test(`审片浏览 ${mode} 使用当前候选且键盘不误采用`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '候选浏览边界',
        params: { model: 'plein/mock:image', prompt: '四种不同的水杯', count: 4 },
        x: 400,
        y: 300,
      }),
    )
    const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
      )
      .toBe(200)
    expect(
      (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
    ).toBe(202)
    await waitNode(page, id)
    const before = await page.evaluate(
      (id) => ({
        results: window.__plein.engine.doc.get(id)!.results!,
        adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
        rect: window.__plein.engine.doc.worldRect(id),
      }),
      id,
    )
    expect(before.results).toHaveLength(4)
    expect(new Set(before.results.map((result) => result.value.assetId)).size).toBe(4)
    await page.getByRole('treeitem', { name: '候选浏览边界 定位到画布', exact: true }).click()
    await page
      .getByTestId('generator')
      .getByRole('button', { name: '全屏查看', exact: true })
      .click()
    const viewer = page.getByRole('dialog', { name: '查看「候选浏览边界」', exact: true })
    const group = viewer.getByRole('group', { name: '候选审片操作', exact: true })
    const image = viewer.locator('img').first()
    const next = viewer.getByRole('button', { name: '预览下一个候选', exact: true })
    if (mode === 'removed' || mode === 'inserted') {
      await next.evaluate(
        (button, { id, mode, results }) => {
          const node = window.__plein.engine.doc.mutable(id) as unknown as {
            set(key: string, value: unknown): void
          }
          node.set(
            'results',
            mode === 'removed'
              ? results.filter((result) => result.id !== results[1]!.id)
              : [
                  results[0],
                  {
                    ...results[0],
                    id: 'other-port',
                    port: 'metadata',
                    value: { type: 'text', text: '忽略此端口' },
                  },
                  { ...results[3], id: 'inserted', runId: 'inserted-run' },
                  ...results.slice(1),
                ],
          )
          ;(button as HTMLButtonElement).click()
        },
        { id, mode, results: before.results },
      )
      await expect(image).toHaveAttribute(
        'src',
        `/api/assets/${before.results[mode === 'removed' ? 2 : 3]!.value.assetId}`,
        { timeout: 1500 },
      )
      if (mode === 'inserted') {
        await expect(viewer.getByText('候选 2 / 5', { exact: true })).toBeVisible()
        await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
        ).toBe('inserted')
      }
    } else if (mode === 'rapid') {
      await next.evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
      })
      await expect(image).toHaveAttribute('src', `/api/assets/${before.results[2]!.value.assetId}`)
    } else {
      await group.focus()
      if (mode === 'modifiers') {
        for (const modifier of ['Control', 'Meta', 'Alt', 'Shift']) {
          await page.keyboard.press(`${modifier}+ArrowRight`)
          await expect(image).toHaveAttribute(
            'src',
            `/api/assets/${before.results[0]!.value.assetId}`,
            { timeout: 1500 },
          )
        }
      }
      await page.keyboard.press('ArrowRight')
      await expect(image).toHaveAttribute('src', `/api/assets/${before.results[1]!.value.assetId}`)
      if (mode === 'composing') {
        await group.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
        ).toBe(before.adopted)
        await group.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
      } else if (mode === 'modifiers') {
        for (const modifier of ['Control', 'Meta', 'Alt', 'Shift'])
          await page.keyboard.press(`${modifier}+Enter`)
      } else {
        await viewer
          .getByRole('combobox', { name: '对比候选', exact: true })
          .selectOption(before.results[2]!.id)
        await viewer.getByRole('combobox', { name: '对比方式', exact: true }).selectOption('slider')
        const slider = viewer.getByRole('slider', { name: '图片对比滑杆', exact: true })
        await slider.focus()
        await slider.press('ArrowRight')
        await expect(slider).toHaveValue('51')
        await expect(image).toHaveAttribute(
          'src',
          `/api/assets/${before.results[1]!.value.assetId}`,
        )
        const zoom = viewer.getByRole('button', { name: '放大图片', exact: true })
        await zoom.focus()
        await zoom.press('Enter')
        await expect(viewer.getByRole('button', { name: '重置图片视图', exact: true })).toHaveText(
          '125%',
        )
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
        ).toBe(before.adopted)
        await group.focus()
        await page.keyboard.press('Enter')
      }
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
      ).toBe(mode === 'controls' ? before.results[1]!.id : before.adopted)
      expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(
        before.rect,
      )
    }
    await viewer.screenshot({
      path: test.info().outputPath('viewer-browse-keys.png'),
      animations: 'disabled',
    })
  })
}
