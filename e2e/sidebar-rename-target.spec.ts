import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
async function setup(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const engine = window.__plein.engine as unknown as Engine
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '相同名称',
      params: { text: '原正文' },
      x: 500,
      y: 300,
    })
    const other = window.__plein.addNode({
      type: 'plein/text',
      name: '旁边节点',
      params: { text: '旁边正文' },
      x: 1000,
      y: 300,
    })
    engine.selection.clear()
    engine.doc.undo.clear()
    return { id, other }
  })
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  const row = sidebar.locator(`[role="treeitem"][data-id="${ids.id}"]`)
  await row.press('F2')
  const input = row.getByRole('textbox', { name: '元素名称', exact: true })
  await input.fill('旧草稿不能写入新节点')
  return { ...ids, sidebar, row, input }
}

for (const finish of ['Enter', 'blur', 'rendered'] as const) {
  test(`改名中同 ID 新节点替换，${finish} 不保存旧草稿且可以重新改名`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const f = await setup(page)
    const state = await f.input.evaluate(
      (input, { id, other, finish }) => {
        const engine = window.__plein.engine as unknown as Engine
        engine.doc.ydoc.transact(() => {
          const next = engine.doc.mutable(id)!.clone()
          engine.doc.elementMaps.set(id, next)
          next.set('x', 1800)
        }, engine.doc.origin)
        const before = engine.doc.get(id)
        if (finish === 'Enter')
          input.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              bubbles: true,
              cancelable: true,
            }),
          )
        else if (finish === 'blur')
          document.querySelector<HTMLElement>(`[role="treeitem"][data-id="${other}"]`)!.focus()
        const after = engine.doc.get(id)
        engine.doc.flush()
        return { before, after }
      },
      { id: f.id, other: f.other, finish },
    )
    expect(state.after).toEqual(state.before)
    await expect(f.input).toHaveCount(0)
    if (finish === 'blur')
      await expect(f.sidebar.locator(`[role="treeitem"][data-id="${f.other}"]`)).toBeFocused()
    else await expect(f.row).toBeFocused()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.id)).toBe(
      '相同名称',
    )
    await f.row.press('F2')
    await expect(f.input).toHaveValue('相同名称')
    await f.input.fill('新节点确认后的名称')
    await f.input.press('Enter')
    await expect(f.row).toBeFocused()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.id)).toBe(
      '新节点确认后的名称',
    )
    await f.row.screenshot({ path: test.info().outputPath('rename-replacement-recovered.png') })
    expect(errors).toEqual([])
  })
}

test('同一节点的独立几何更新保留改名草稿，名称撤销不回退几何', async ({ page }) => {
  const f = await setup(page)
  await page.evaluate((id) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.doc.undo.stopCapturing()
    engine.doc.ydoc.transact(() => engine.doc.mutable(id)!.set('rotation', 15), engine.doc.origin)
    engine.doc.flush()
  }, f.id)
  await expect(f.input).toHaveValue('旧草稿不能写入新节点')
  await f.input.press('Enter')
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.id)).toBe(
    '旧草稿不能写入新节点',
  )
  await page.evaluate(() => (window.__plein.engine as unknown as Engine).undo())
  expect(
    await page.evaluate((id) => {
      const node = (window.__plein.engine as unknown as Engine).doc.get(id)!
      return { name: node.name, rotation: node.rotation }
    }, f.id),
  ).toEqual({ name: '相同名称', rotation: 15 })
})
