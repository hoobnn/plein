import { expect, type Page, test } from './fixtures'
import { newProject, waitNode } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const text = window.__plein.addNode({
      type: 'plein/llm',
      name: '镜头文案',
      params: { model: 'plein/mock:chat', prompt: '清晨水杯' },
      x: 0,
      y: 0,
    })
    const image = window.__plein.addNode({
      type: 'plein/image',
      name: '镜头画面',
      params: { model: 'plein/mock:image', prompt: '写实摄影' },
      x: 800,
      y: 0,
    })
    window.__plein.connect([text, 'text'], [image, 'prompt'])
    return { text, image }
  })
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
  for (const id of [ids.text, ids.image]) {
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
      )
      .toBe(200)
    expect(
      (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
    ).toBe(202)
    await waitNode(page, id)
  }
  const before = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].map((el) => ({
      id: el.id,
      adopted: el.adopted,
      results: el.results,
    })),
  )
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: unknown): void
    }
    params.set('prompt', '黄昏水杯')
  }, ids.text)
  const stale = async () => (await page.request.get(`/api/canvases/${canvas}/stale`)).json()
  await expect.poll(stale).toMatchObject({ stale: [ids.text], upstream: [ids.image], kept: [] })
  await expect(page.locator('.plein-node-status').filter({ hasText: '需要重跑' })).toBeVisible()
  return { ids, canvas, stale, before }
}

test('文本参数变化和上游过期在故事板显示重跑提示，结果仍可查看', async ({ page }) => {
  const f = await fixture(page)
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const text = page.getByRole('region', { name: '文本', exact: true })
  const image = page.getByRole('region', { name: '图片', exact: true })
  await expect(text.getByText('需要重跑', { exact: true })).toBeVisible()
  await expect(image.getByText('上游已改', { exact: true })).toBeVisible()
  await expect(text.getByText('需要重跑', { exact: true })).toHaveAttribute(
    'title',
    /参数或输入改过/,
  )
  await page.waitForFunction(() => !document.documentElement.dataset.viewSlide)
  const badge = text.getByText('需要重跑', { exact: true })
  expect(
    await badge.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el
    }),
  ).toBe(true)
  await badge.hover()
  await image.getByRole('button', { name: '查看镜头画面', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '查看「镜头画面」', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(
    await page.evaluate(() =>
      [...window.__plein.engine.doc.elements()].map((el) => ({
        id: el.id,
        adopted: el.adopted,
        results: el.results,
      })),
    ),
  ).toEqual(f.before)
})

test('通过影响面板保留与撤销保留后，无文档编辑也立即刷新当前卡片状态', async ({ page }) => {
  const f = await fixture(page)
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  const impact = page.getByRole('dialog', { name: '查看影响', exact: true })
  await expect(impact).toBeVisible()
  const row = impact
    .getByRole('listitem')
    .filter({ has: page.getByRole('checkbox', { name: '重做镜头文案', exact: true }) })
  await row.getByRole('button', { name: '保留', exact: true }).click()
  await expect(row.getByRole('button', { name: '撤销保留', exact: true })).toBeVisible()
  await expect.poll(f.stale).toMatchObject({ kept: [f.ids.text] })
  await page.keyboard.press('Escape')
  await expect(impact).toHaveCount(0)
  await expect(page.locator('.plein-node-status').filter({ hasText: '已保留' })).toBeVisible()
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const text = page.getByRole('region', { name: '文本', exact: true })
  await expect(text.getByText('已保留', { exact: true })).toBeVisible()
  await page.waitForFunction(() => !document.documentElement.dataset.viewSlide)
  await page.screenshot({
    path: test.info().outputPath('board-stale-kept.png'),
    animations: 'disabled',
  })
  await text.getByRole('button', { name: '镜头文案', exact: true }).click()
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  await row.getByRole('button', { name: '撤销保留', exact: true }).click()
  await expect.poll(f.stale).toMatchObject({ kept: [] })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(text.getByText('需要重跑', { exact: true })).toBeVisible()
})

test('排队、生成和失败优先显示运行状态，结束后恢复真实过期提示', async ({ page }) => {
  const f = await fixture(page)
  const original = await page.evaluate(
    (id) => window.__plein.engine.doc.mutable(id)!.get('run'),
    f.ids.text,
  )
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const text = page.getByRole('region', { name: '文本', exact: true })
  await expect(text.getByText('需要重跑', { exact: true })).toBeVisible()
  for (const [status, label] of [
    ['queued', '排队中'],
    ['running', '生成中'],
    ['failed', '失败'],
  ]) {
    await page.evaluate(
      ({ id, original, status }) =>
        (
          window.__plein.engine.doc.mutable(id) as unknown as {
            set(key: string, value: unknown): void
          }
        ).set('run', { ...(original as object), status }),
      { id: f.ids.text, original, status },
    )
    await expect(text.getByText(label!, { exact: true })).toBeVisible()
    await expect(text.getByText('需要重跑', { exact: true })).toHaveCount(0)
  }
  await page.evaluate(
    ({ id, original }) =>
      (
        window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('run', original),
    { id: f.ids.text, original },
  )
  await expect(text.getByText('需要重跑', { exact: true })).toBeVisible()
})
