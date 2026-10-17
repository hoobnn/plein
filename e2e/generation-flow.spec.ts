import { expect, test, type Page } from '@playwright/test'
import { clickElement, deselect, newProject, waitNode, zoomTo } from './canvas'

test('图片派生视频自动使用首帧模式，正文遵循图片遮挡并在移开后恢复', async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const add = window.__plein.addNode
    return {
      text: add({
        type: 'plein/llm',
        name: '遮挡正文',
        params: { model: 'plein/mock:chat', prompt: '测试正文遮挡' },
        x: 0,
        y: 0,
      }),
      image: add({
        type: 'plein/image',
        name: '上层图片',
        params: { model: 'plein/mock:image', prompt: '测试图片' },
        x: 0,
        y: 0,
      }),
    }
  })
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!
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
  await clickElement(page, ids.image)
  await page.getByTestId('generator').getByRole('button', { name: '生成视频', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/video')
            ?.params?.mode,
      ),
    )
    .toBe('image')
  const input = await page.request.get(
    `/api/canvases/${canvas}/nodes/${await page.evaluate(() => [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/video')!.id)}/input`,
  )
  expect(input.status()).toBe(200)
  expect(JSON.stringify(await input.json())).toContain(ids.image)

  await deselect(page)
  await page.evaluate(({ text, image }) => {
    const doc = window.__plein.engine.doc
    const rect = doc.worldRect(text)
    const target = doc.mutable(image) as unknown as { set(key: string, value: number): void }
    for (const [key, value] of Object.entries(rect)) target.set(key, value)
  }, ids)
  await zoomTo(page, [ids.text, ids.image])
  const card = page
    .locator('.plein-node')
    .filter({ has: page.locator('.plein-node-title', { hasText: '遮挡正文' }) })
  await expect(card).toBeAttached()
  await expect.poll(() => card.evaluate((el) => el.style.clipPath)).not.toBe('')
  const crop = async () =>
    page.evaluate((id) => {
      const engine = window.__plein.engine
      const r = engine.doc.worldRect(id)
      const a = engine.worldToClient(r.x + 20, r.y + 20)
      const b = engine.worldToClient(r.x + r.w - 20, r.y + r.h - 20)
      return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }
    }, ids.text)
  const compareHidden = async (page: Page) => {
    const clip = await crop()
    const visible = await page.screenshot({ clip })
    await card.evaluate((el) => {
      el.style.visibility = 'hidden'
    })
    const hidden = await page.screenshot({ clip })
    await card.evaluate((el) => {
      el.style.visibility = ''
    })
    return visible.equals(hidden)
  }
  expect(await compareHidden(page), '被上层图片盖住时正文不应出现在像素中').toBe(true)
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc
    const r = doc.worldRect(id)
    ;(doc.mutable(id) as unknown as { set(key: string, value: number): void }).set(
      'x',
      r.x + r.w + 100,
    )
  }, ids.image)
  await expect.poll(() => card.evaluate((el) => el.style.clipPath)).toBe('')
  expect(await compareHidden(page), '移开图片后正文重新可见').toBe(false)
})
