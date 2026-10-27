import { expect, test } from './fixtures'
import { newProject, waitNode } from './canvas'

for (const mode of ['removed', 'replaced', 'deleted', 'readonly', 'normal'] as const) {
  test(`审片旧操作 ${mode} 复核候选与来源身份`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '审片操作身份',
        params: { model: 'plein/mock:image', prompt: '不同水杯', count: 2 },
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
        adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
        results: window.__plein.engine.doc.get(id)!.results!,
      }),
      id,
    )
    if (mode === 'replaced') await page.setViewportSize({ width: 390, height: 640 })
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '生成历史', exact: true })
    await history.getByRole('listitem').last().getByRole('button').first().click()
    const viewer = page.getByRole('dialog', { name: '查看「审片操作身份」', exact: true })
    const action = viewer.getByRole('button', {
      name: mode === 'deleted' ? '定位来源' : '采用此候选',
      exact: true,
    })
    if (mode === 'normal') {
      await action.click()
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
      ).toBe(before.results[1]!.id)
      await page.evaluate(() =>
        (window.__plein.engine.doc as unknown as { undo: { undo(): void } }).undo.undo(),
      )
      await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
      ).toBe(before.adopted)
      await page.evaluate(() =>
        (window.__plein.engine.doc as unknown as { undo: { redo(): void } }).undo.redo(),
      )
      await expect(viewer.getByRole('button', { name: '已采用', exact: true })).toBeDisabled()
    } else {
      await action.evaluate(
        (button, { id, selected, first, mode }) => {
          const engine = window.__plein.engine as typeof window.__plein.engine & {
            deleteSelection(): void
            doc: { readOnly: boolean; undo: { stopCapturing(): void } }
          }
          const node = engine.doc.mutable(id) as unknown as {
            get(key: string): unknown
            set(key: string, value: unknown): void
          }
          if (mode === 'deleted') {
            engine.doc.undo.stopCapturing()
            engine.selection.set([id])
            engine.deleteSelection()
          } else if (mode === 'readonly') engine.doc.readOnly = true
          else {
            const results = node.get('results') as Array<{ id: string; value: unknown }>
            node.set(
              'results',
              mode === 'removed'
                ? results.filter((result) => result.id !== selected.id)
                : results.map((result) =>
                    result.id === selected.id ? { ...result, value: first.value } : result,
                  ),
            )
          }
          ;(button as HTMLButtonElement).click()
        },
        { id, selected: before.results[1]!, first: before.results[0]!, mode },
      )
      if (mode === 'deleted') {
        await expect
          .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
          .toEqual([])
        await expect(viewer).toBeVisible()
        await expect(viewer.getByRole('alert')).toContainText('本次定位未执行')
        await viewer.screenshot({
          path: test.info().outputPath('viewer-action-rejected.png'),
          animations: 'disabled',
        })
        await page.evaluate(() =>
          (window.__plein.engine.doc as unknown as { undo: { undo(): void } }).undo.undo(),
        )
        await expect(viewer.getByRole('button', { name: '定位来源', exact: true })).toBeVisible()
        await viewer.getByRole('button', { name: '定位来源', exact: true }).click()
        await expect(viewer).toHaveCount(0)
        expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
      } else {
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
        ).toBe(before.adopted)
        await expect(viewer.getByRole('alert')).toContainText('本次采用未执行')
        await viewer.screenshot({
          path: test.info().outputPath('viewer-action-rejected.png'),
          animations: 'disabled',
        })
        await page.evaluate(
          ({ id, results }) => {
            const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
              readOnly: boolean
            }
            doc.readOnly = false
            ;(doc.mutable(id) as unknown as { set(k: string, v: unknown): void }).set(
              'results',
              results,
            )
          },
          { id, results: before.results },
        )
        await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
        await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
        ).toBe(before.results[1]!.id)
      }
    }
    await page.screenshot({
      path: test.info().outputPath('viewer-action-result.png'),
      animations: 'disabled',
    })
  })
}
