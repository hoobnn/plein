import { expect, test } from '@playwright/test'
import { centerOf, elements, newProject } from './canvas'

for (const mode of ['composing', 'legacy', 'legacy-27', 'end-229'] as const) {
  test(`画布便签 IME Escape 不退出编辑，${mode}，组字后仍可保存和正常退出`, async ({ page }) => {
    await newProject(page)
    await page
      .locator('canvas')
      .first()
      .evaluate((canvas) => {
        const data = new DataTransfer()
        data.setData('text/plain', '保留的便签正文')
        canvas.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
        )
      })
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'markdown').length)
      .toBe(1)
    const note = (await elements(page)).find((el) => el.kind === 'markdown')!
    const point = await centerOf(page, note.id)
    await page.mouse.dblclick(point.x, point.y)
    const editor = page.locator('.plein-md-editor .cm-content')
    await expect(editor).toBeFocused()
    const prevented = await editor.evaluate((node, mode) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }))
      if (mode === 'end-229')
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: mode === 'composing' || mode === 'legacy-27' ? 27 : 229,
        isComposing: mode === 'composing',
        bubbles: true,
        cancelable: true,
      })
      node.dispatchEvent(event)
      return event.defaultPrevented
    }, mode)
    expect(prevented).toBe(false)
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()
    if (mode === 'composing')
      await page.screenshot({
        path: test.info().outputPath('markdown-ime-active.png'),
        animations: 'disabled',
      })
    await editor.evaluate((node) =>
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })),
    )
    await editor.press('End')
    await page.keyboard.insertText('，中文追加')
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), note.id))
      .toContain('中文追加')
    await editor.press('Escape')
    await expect(page.locator('.plein-md-editor')).toHaveCount(0)
    expect((await elements(page)).map((el) => el.id)).toContain(note.id)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([note.id])
    const after = await page.evaluate(
      (id) => window.__plein.engine.doc.getText(id)?.toString(),
      note.id,
    )
    expect(after).toContain('保留的便签正文')
    expect(after).toContain('中文追加')
  })
}

test('便签 Esc 先取消文本选择，再退出编辑，正文和画布选择不受影响', async ({ page }) => {
  await newProject(page)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'Esc 选择边界正文')
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      )
    })
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.kind === 'markdown').length)
    .toBe(1)
  const note = (await elements(page)).find((el) => el.kind === 'markdown')!
  const point = await centerOf(page, note.id)
  await page.mouse.dblclick(point.x, point.y)
  const editor = page.locator('.plein-md-editor .cm-content')
  await expect(editor).toBeFocused()
  await editor.press('ControlOrMeta+a')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain('Esc 选择边界正文')
  await editor.press('Escape')
  await expect(editor).toBeVisible()
  await expect(editor).toBeFocused()
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), note.id),
  ).toBe('Esc 选择边界正文')
  await editor.press('Escape')
  await expect(page.locator('.plein-md-editor')).toHaveCount(0)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([note.id])
})
