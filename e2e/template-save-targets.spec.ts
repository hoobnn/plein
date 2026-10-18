import { expect, test } from '@playwright/test'
import type { UserTemplate } from '../packages/protocol/src/templates'
import { newProject } from './canvas'

for (const change of ['selection', 'deleted', 'cancel', 'retry', 'success'] as const) {
  test(`多选模板保存 ${change} 核对原目标，失败重试不重复打组`, async ({ page }) => {
    await newProject(page)
    const ids = await page.evaluate(() => {
      const a = window.__plein.addNode({
        type: 'plein/text',
        name: '模板目标甲',
        params: { text: '透明水杯' },
        x: 300,
        y: 200,
      })
      const b = window.__plein.addNode({
        type: 'plein/image',
        name: '模板目标乙',
        params: { model: 'plein/mock:image' },
        x: 760,
        y: 200,
      })
      const other = window.__plein.addNode({
        type: 'plein/text',
        name: '不应存入模板',
        params: { text: '其他内容' },
        x: 1800,
        y: 200,
      })
      window.__plein.connect([a, 'text'], [b, 'prompt'])
      window.__plein.engine.selection.set([a, b])
      window.__plein.engine.zoomToFit([a, b])
      return { a, b, other }
    })
    const title = `模板目标测试-${change}-${Date.now()}`
    const requests: unknown[] = []
    await page.route('**/api/templates', (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      requests.push(route.request().postDataJSON())
      if (change === 'retry' && requests.length === 1)
        return route.fulfill({
          status: 503,
          json: { error: 'template_failed', message: '模板保存测试失败' },
        })
      return route.continue()
    })
    const templates = async () =>
      (await (await page.request.get('/api/templates')).json()) as UserTemplate[]
    const frames = () =>
      page.evaluate(() =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => el.kind === 'frame')
          .map((el) => el.id),
      )
    try {
      await page
        .getByRole('toolbar', { name: '多选操作', exact: true })
        .getByRole('button', { name: '存为模板', exact: true })
        .click()
      const dialog = page.getByRole('dialog', { name: '存为模板', exact: true })
      await dialog.getByRole('textbox').fill(title)
      if (change === 'cancel') {
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
      } else {
        if (change === 'selection')
          await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids.other)
        if (change === 'deleted')
          await page.evaluate((id) => {
            window.__plein.engine.selection.set([id])
            ;(window.__plein.engine as unknown as { deleteSelection(): void }).deleteSelection()
          }, ids.a)
        await dialog.getByRole('button', { name: '保存', exact: true }).click()
        if (change === 'selection' || change === 'deleted') {
          await expect(page.locator('.ui-toast')).toContainText(
            '模板目标已变化，请重新选择后保存',
            { timeout: 1500 },
          )
        } else {
          if (change === 'retry') {
            await expect(page.locator('.ui-toast')).toContainText('模板保存测试失败')
            expect(requests).toHaveLength(1)
            expect(await frames()).toHaveLength(1)
            await page
              .getByRole('toolbar', { name: 'Frame 操作', exact: true })
              .getByRole('button', { name: '存为模板', exact: true })
              .click()
            await dialog.getByRole('textbox').fill(title)
            await dialog.getByRole('button', { name: '保存', exact: true }).click()
          }
          await expect
            .poll(async () => (await templates()).filter((item) => item.title === title).length)
            .toBe(1)
          const saved = (await templates()).find((item) => item.title === title)!
          expect(saved.data.elements).toHaveLength(3)
          expect(saved.data.elements.map((el) => el.id)).toEqual(
            expect.arrayContaining([ids.a, ids.b]),
          )
          expect(saved.data.elements.some((el) => el.id === ids.other)).toBe(false)
          expect(saved.data.edges).toHaveLength(1)
          expect(saved.data.extensions).toHaveProperty('plein/mentions')
          expect(await frames()).toHaveLength(1)
          expect(requests).toHaveLength(change === 'retry' ? 2 : 1)
        }
      }
      if (['selection', 'deleted', 'cancel'].includes(change)) {
        expect(requests).toHaveLength(0)
        expect(await frames()).toHaveLength(0)
        expect((await templates()).some((item) => item.title === title)).toBe(false)
      }
      await page.screenshot({
        path: test.info().outputPath('template-save-target.png'),
        animations: 'disabled',
      })
    } finally {
      for (const item of await templates())
        if (item.title === title) await page.request.delete(`/api/templates/${item.id}`)
    }
  })
}
