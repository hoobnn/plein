import { expect, type Page, test } from '@playwright/test'
import { centerOf, elements, newProject, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
async function setup(page: Page) {
  await newProject(page)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => {
      const data = new DataTransfer()
      data.setData('text/plain', '正文原始内容')
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    })
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.kind === 'markdown').length)
    .toBe(1)
  const id = (await elements(page)).find((el) => el.kind === 'markdown')!.id
  await open(page, id)
  const editor = page.locator('.plein-md-editor .cm-content')
  await editor.press('End')
  await page.keyboard.insertText('，已保存的编辑')
  await expect.poll(() => read(page, id)).toBe('正文原始内容，已保存的编辑')
  return { id, editor }
}
async function open(page: Page, id: string) {
  await zoomTo(page, [id])
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(page.locator('.plein-md-editor .cm-content')).toBeFocused()
}
const read = (page: Page, id: string) =>
  page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id)

for (const action of ['type', 'delete', 'undo', 'redo'] as const) {
  test(`便签编辑中转只读，迟到的 ${action} 不改正文，退出后可重新编辑`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const { id, editor } = await setup(page)
    if (action === 'redo') await editor.press('ControlOrMeta+z')
    const before = await read(page, id)
    // 在真实输入事件进入编辑器时转只读，确保验证权限守卫，避免帧同步先关闭编辑器。
    await editor.evaluate((el, action) => {
      const eventType = action === 'type' ? 'beforeinput' : 'keydown'
      const guard = (event: Event) => {
        if (
          event instanceof KeyboardEvent &&
          !(action === 'delete'
            ? event.key === 'Backspace'
            : event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey))
        )
          return
        el.removeEventListener(eventType, guard, true)
        ;(window.__plein.engine as unknown as Engine).doc.readOnly = true
      }
      el.addEventListener(eventType, guard, true)
    }, action)
    if (action === 'type') await page.keyboard.insertText('，只读不应写入')
    else if (action === 'delete') {
      await editor.press('ControlOrMeta+a')
      await editor.press('Backspace')
    } else await editor.press(action === 'undo' ? 'ControlOrMeta+z' : 'ControlOrMeta+Shift+z')
    expect(
      await page.evaluate(() => (window.__plein.engine as unknown as Engine).doc.readOnly),
    ).toBe(true)
    expect(await read(page, id)).toBe(before)
    await page.evaluate(() => (window.__plein.engine as unknown as Engine).refreshState())
    await expect(page.locator('.plein-md-editor')).toHaveCount(0)
    expect(
      await page
        .locator('canvas')
        .first()
        .evaluate((canvas) => document.activeElement === canvas.parentElement),
    ).toBe(true)
    await expect(
      page.locator('.plein-md-preview:not([aria-hidden]) .plein-md-content'),
    ).toContainText(before!)
    if (action === 'type')
      await page.screenshot({ path: test.info().outputPath('readonly-editor-closed.png') })
    expect(errors).toEqual([])
    await page.evaluate(() => {
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.readOnly = false
      engine.refreshState()
    })
    await open(page, id)
    await editor.press('End')
    await page.keyboard.insertText('，恢复编辑')
    await expect.poll(() => read(page, id)).toBe(`${before}，恢复编辑`)
    await editor.press('ControlOrMeta+z')
    await expect.poll(() => read(page, id)).toBe(before)
    await editor.press('Escape')
    await expect(page.locator('.plein-md-editor')).toHaveCount(0)
    expect(
      await page
        .locator('canvas')
        .first()
        .evaluate((canvas) => document.activeElement === canvas.parentElement),
    ).toBe(true)
    expect(errors).toEqual([])
  })
}

for (const change of ['delete', 'kind', 'element', 'text', 'lock'] as const) {
  test(`便签编辑目标 ${change} 后旧撤销不写回，关闭并撤销外部变化后可重开`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const { id, editor } = await setup(page)
    const body = await read(page, id)
    const state = await editor.evaluate(
      (el, { id, change }) => {
        const engine = window.__plein.engine as unknown as Engine
        const doc = engine.doc
        const original = doc.getText(id)!
        doc.undo.clear()
        doc.ydoc.transact(() => {
          const target = doc.mutable(id)!
          if (change === 'delete') doc.elementMaps.delete(id)
          else if (change === 'kind') {
            target.set('kind', 'node')
            target.set('nodeType', 'plein/text')
            target.set('params', {})
          } else if (change === 'lock') target.set('locked', true)
          else {
            if (change === 'element') doc.elementMaps.set(id, target.clone())
            else target.set('text', original.clone())
            const text = doc.getText(id)!
            text.delete(0, text.length)
            text.insert(0, '替换后的新正文')
          }
        }, doc.origin)
        const snapshot = () => ({ current: doc.get(id), oldText: original.toString() })
        const before = snapshot()
        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'z',
            code: 'KeyZ',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
        const after = snapshot()
        doc.flush()
        engine.refreshState()
        return { before, after }
      },
      { id, change },
    )
    expect(state.after).toEqual(state.before)
    await expect(page.locator('.plein-md-editor')).toHaveCount(0)
    expect(
      await page
        .locator('canvas')
        .first()
        .evaluate((canvas) => document.activeElement === canvas.parentElement),
    ).toBe(true)
    expect(errors).toEqual([])
    await page.evaluate(() => (window.__plein.engine as unknown as Engine).undo())
    await expect.poll(() => read(page, id)).toBe(body)
    await open(page, id)
    await editor.press('End')
    await page.keyboard.insertText('，重新打开后')
    await expect.poll(() => read(page, id)).toBe(`${body}，重新打开后`)
    expect(errors).toEqual([])
  })
}
