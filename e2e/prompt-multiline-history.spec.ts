import { expect, test } from './fixtures'
import { clickElement, newProject } from './canvas'

for (const replace of [true, false]) {
  test(`提示词多行粘贴${replace ? '替换' : '追加'}后，原生撤销重做保留正文与文档`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/text',
        name: '多行历史',
        params: { text: 'Base' },
        x: 0,
        y: 0,
      }),
    )
    await clickElement(page, id)
    const field = page
      .getByTestId('generator')
      .getByRole('textbox', { name: '提示词', exact: true })
    await expect(field).toHaveValue('Base')
    await field.focus()
    await field.press('ControlOrMeta+a')
    if (!replace) await field.press('ArrowRight')
    await page.evaluate(() => navigator.clipboard.writeText('A\nB'))
    await field.press('ControlOrMeta+v')
    const expected = replace ? 'A\nB' : 'BaseA\nB'
    await expect(field).toHaveValue(expected)
    await field.press('ControlOrMeta+z')
    await expect(field).toHaveValue('Base')
    await field.press('ControlOrMeta+Shift+z')
    await expect(field).toHaveValue(expected)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id))
      .toBe(expected)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(1)
    await page.reload()
    await page.waitForFunction(() => !!window.__plein)
    await page.getByRole('treeitem', { name: '多行历史 定位到画布', exact: true }).click()
    await expect(field).toHaveValue(expected)
  })
}
