import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject, zoomTo } from './canvas'

test('从未选中元素上右键拖动只平移画布，轻点才选择目标并弹菜单', async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() =>
    [0, 1].map((i) =>
      window.__plein.addNode({
        type: 'plein/text',
        name: `右键测试 ${i}`,
        params: { text: '正文' },
        x: 300 + i * 400,
        y: 200,
      }),
    ),
  )
  await clickElement(page, ids[0]!)
  await zoomTo(page, ids)
  const positions = () =>
    page.evaluate(
      (ids) =>
        ids.map((id) => {
          const el = window.__plein.engine.doc.worldRect(id)!
          return [el.x, el.y]
        }),
      ids,
    )
  const before = await positions()
  const p = await centerOf(page, ids[1]!)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.mouse.move(p.x + 120, p.y - 60, { steps: 8 })
  // 刻意停稳后松手，单独测平移距离，不把惯性位移混进断言。
  await page.waitForTimeout(120)
  await page.mouse.up({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  expect(await positions()).toEqual(before)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids[0]])
  const after = await centerOf(page, ids[1]!)
  expect(Math.abs(after.x - p.x - 120)).toBeLessThan(1)
  expect(Math.abs(after.y - p.y + 60)).toBeLessThan(1)
  await page.mouse.move(after.x, after.y)
  await page.mouse.down({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.mouse.move(after.x + 1, after.y + 1)
  await page.mouse.up({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  expect(await positions()).toEqual(before)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids[1]])
})

test('右键手势取消后不留下菜单或粘住的平移', async ({ page }) => {
  await newProject(page)
  const canvas = page.locator('canvas').first()
  const x = 1000,
    y = 200
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await canvas.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', button: 2 })
  await page.mouse.up({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  const state = () => page.evaluate(() => window.__plein.engine.worldToClient(0, 0))
  const before = await state()
  await page.mouse.move(x + 100, y + 100)
  expect(await state()).toEqual(before)
  await page.mouse.click(1000, 200, { button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
})
