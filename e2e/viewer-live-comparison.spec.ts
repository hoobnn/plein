import { expect, test } from '@playwright/test'
import type { Catalog } from '../packages/protocol/src/plugins'
import { newProject, waitNode } from './canvas'

for (const mode of ['rename', 'clear-name', 'self', 'type', 'replace', 'stable'] as const) {
  test(`审片实时信息 ${mode} 标题与对比状态一致`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '对比实时更新',
        params: { model: 'plein/mock:image', prompt: '四个不同的杯子', count: 4 },
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
      }),
      id,
    )
    await page.getByRole('treeitem', { name: '对比实时更新 定位到画布', exact: true }).click()
    await page
      .getByTestId('generator')
      .getByRole('button', { name: '全屏查看', exact: true })
      .click()
    const viewer = page.getByRole('dialog')
    if (mode === 'rename' || mode === 'clear-name') {
      await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
      const response = await page.request.get('/api/catalog')
      expect(response.status()).toBe(200)
      const catalog = (await response.json()) as Catalog
      const name =
        mode === 'rename'
          ? '改名后的雨后水杯'
          : catalog.nodes.find((node) => node.type === 'plein/image')!.title
      await page.evaluate(
        ({ id, name }) =>
          (
            window.__plein.engine.doc.mutable(id) as unknown as {
              set(key: string, value: unknown): void
            }
          ).set('name', name),
        { id, name: mode === 'rename' ? name : '' },
      )
      await expect(viewer).toHaveAttribute('aria-label', `查看「${name}」`, { timeout: 1500 })
      await expect(viewer.getByRole('heading', { name, exact: true })).toBeVisible()
      await expect(viewer.getByRole('img', { name, exact: true })).toHaveAttribute(
        'src',
        `/api/assets/${before.results[0]!.value.assetId}`,
      )
      await expect(viewer.getByRole('button', { name: '重置图片视图', exact: true })).toHaveText(
        '125%',
      )
      if (mode === 'rename') {
        await page.evaluate((id) => {
          const engine = window.__plein.engine as typeof window.__plein.engine & {
            deleteSelection(): void
            doc: { undo: { stopCapturing(): void } }
          }
          engine.doc.undo.stopCapturing()
          engine.selection.set([id])
          engine.deleteSelection()
        }, id)
        await expect(
          viewer.getByText('来源节点已删除，恢复节点后可继续审片。', { exact: true }),
        ).toBeVisible()
        await expect(viewer.getByRole('heading', { name, exact: true })).toBeVisible()
        await page.evaluate(() =>
          (window.__plein.engine.doc as unknown as { undo: { undo(): void } }).undo.undo(),
        )
        await expect(viewer.getByRole('img', { name, exact: true })).toBeVisible()
      }
    } else {
      const select = viewer.getByRole('combobox', { name: '对比候选', exact: true })
      const index = mode === 'stable' ? 2 : 1
      await select.selectOption(before.results[index]!.id)
      const b = viewer.getByRole('img', { name: '候选 B', exact: true })
      await expect(b).toHaveAttribute('src', `/api/assets/${before.results[index]!.value.assetId}`)
      if (mode === 'self') {
        await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
        await expect(b).toHaveCount(0, { timeout: 1500 })
        await expect(select).toHaveValue('')
        await expect(viewer.getByRole('status')).toContainText('当前候选与对比候选相同')
      } else if (mode === 'type') {
        await page.evaluate(
          ({ id, resultId }) => {
            const doc = window.__plein.engine.doc
            const results = doc
              .get(id)!
              .results!.map((result) =>
                result.id === resultId
                  ? { ...result, value: { type: 'text', text: '已变更类型' } }
                  : result,
              )
            ;(doc.mutable(id) as unknown as { set(key: string, value: unknown): void }).set(
              'results',
              results,
            )
          },
          { id, resultId: before.results[1]!.id },
        )
        await expect(select).toHaveValue('')
        await expect(viewer.getByRole('status')).toContainText('对比候选已不再是图片', {
          timeout: 1500,
        })
        await expect(b).toHaveCount(0)
      } else if (mode === 'replace') {
        const surface = viewer.getByRole('img', { name: '候选 A', exact: true }).locator('..')
        const box = (await surface.boundingBox())!
        await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 3 + 30, box.y + box.height / 2)
        const transform = await surface.evaluate((node: HTMLElement) => node.style.transform)
        await page.evaluate(
          ({ id, resultId, value }) => {
            const doc = window.__plein.engine.doc
            const results = doc
              .get(id)!
              .results!.map((result) => (result.id === resultId ? { ...result, value } : result))
            ;(doc.mutable(id) as unknown as { set(key: string, value: unknown): void }).set(
              'results',
              results,
            )
          },
          { id, resultId: before.results[1]!.id, value: before.results[3]!.value },
        )
        await expect(b).toHaveAttribute('src', `/api/assets/${before.results[3]!.value.assetId}`)
        await expect(surface).toHaveCSS('cursor', 'grab', { timeout: 1500 })
        await page.mouse.move(box.x + box.width / 3 + 90, box.y + box.height / 2)
        await page.mouse.up()
        expect(await surface.evaluate((node: HTMLElement) => node.style.transform)).toBe(transform)
      } else {
        await viewer.getByRole('combobox', { name: '对比方式', exact: true }).selectOption('slider')
        const slider = viewer.getByRole('slider', { name: '图片对比滑杆', exact: true })
        await slider.fill('70')
        for (const label of ['预览下一个候选', '预览上一个候选']) {
          await viewer.getByRole('button', { name: label, exact: true }).click()
          await expect(select).toHaveValue(before.results[2]!.id)
          await expect(b).toHaveAttribute('src', `/api/assets/${before.results[2]!.value.assetId}`)
          await expect(slider).toHaveValue('70')
        }
      }
    }
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
    ).toBe(before.adopted)
    await viewer.screenshot({
      path: test.info().outputPath('viewer-live-comparison.png'),
      animations: 'disabled',
    })
  })
}
