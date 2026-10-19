import { expect, type Page, test } from '@playwright/test'
import { newProject, waitNode } from './canvas'

async function generated(page: Page, kind: 'image' | 'video' | 'audio' = 'image') {
  await newProject(page)
  const id = await page.evaluate(
    (kind) =>
      window.__plein.addNode({
        type: kind === 'audio' ? 'plein/speech' : `plein/${kind}`,
        name: '待审素材',
        params:
          kind === 'audio'
            ? { model: 'plein/mock:audio', text: '雨后的早晨' }
            : { model: `plein/mock:${kind}`, prompt: '雨后的水杯', mode: 'text', count: 2 },
        x: 300,
        y: 200,
      }),
    kind,
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
  return id
}

for (const kind of ['image', 'video', 'audio'] as const) {
  test(`${kind} 尚未采用时显示候选并可审片，预览不误采用，确认后刷新故事板`, async ({ page }) => {
    const id = await generated(page, kind)
    const before = await page.evaluate(
      ({ id, kind }) => {
        const node = window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
        const results = window.__plein.engine.doc.get(id)!.results!
        if (kind === 'image')
          node.set('results', [
            {
              ...results[0],
              id: 'metadata',
              port: 'metadata',
              value: { type: 'text', text: '不能作为图片候选' },
            },
            ...results,
          ])
        node.set('adopted', null)
        return results
      },
      { id, kind },
    )
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    const column = page.getByRole('region', {
      name: kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频',
      exact: true,
    })
    const card = column.getByRole('button', { name: '查看待审素材的候选', exact: true })
    await expect(card).toContainText('待采用')
    await expect(card.locator('img')).toHaveCount(0)
    if (before.length > 1)
      await expect(card.getByLabel(`${before.length} 个候选`, { exact: true })).toBeVisible()
    await page.waitForFunction(() => !document.documentElement.dataset.viewSlide)
    await page.screenshot({
      path: test.info().outputPath(`pending-${kind}.png`),
      animations: 'disabled',
    })
    await card.click()
    const viewer = page.getByRole('dialog', { name: '查看「待审素材」', exact: true })
    await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeVisible()
    if (kind === 'image')
      await expect(viewer.locator('img').first()).toHaveAttribute(
        'src',
        `/api/assets/${before[0]!.value.assetId}`,
      )
    if (before.length > 1)
      await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, id)).toBeNull()
    const chosen = before[before.length > 1 ? 1 : 0]!
    await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(column.getByRole('button', { name: '查看待审素材', exact: true })).toBeVisible()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, id)).toBe(
      chosen.id,
    )
    await column.getByRole('button', { name: '筛选', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '已生成', exact: true }).click()
    await expect(column.locator('.board-item')).toHaveCount(1)
  })
}

test('取消任务取回并采用该任务结果显示已取回，采用旧任务结果仍显示已取消', async ({ page }) => {
  const id = await generated(page)
  const recovered = await page.evaluate((id) => {
    const el = window.__plein.engine.doc.get(id)!
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      get(key: string): unknown
      set(key: string, value: unknown): void
    }
    const run = node.get('run') as Record<string, unknown>
    node.set('run', { ...run, status: 'canceled' })
    return el.adopted!
  }, id)
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const column = page.getByRole('region', { name: '图片', exact: true })
  await expect(column.getByText('已取回', { exact: true })).toBeVisible()
  await expect(column.getByText('已取消', { exact: true })).toHaveCount(0)
  await page.evaluate((id) => {
    const el = window.__plein.engine.doc.get(id)!
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('results', [
      ...el.results!,
      { ...el.results![0], id: 'old-result', runId: 'older-run' },
    ])
    node.set('adopted', 'old-result')
  }, id)
  await expect(column.getByText('已取消', { exact: true })).toBeVisible()
  await page.evaluate(
    ({ id, recovered }) =>
      (
        window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('adopted', recovered),
    { id, recovered },
  )
  await expect(column.getByText('已取回', { exact: true })).toBeVisible()
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, id)).toBe(
    'canceled',
  )
})
