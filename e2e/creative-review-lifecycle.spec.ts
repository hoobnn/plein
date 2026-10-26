import { expect, type Page, test } from '@playwright/test'
import { clickElement, newProject, revealGenerator } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
async function setup(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  await page.route('**/api/assets/review-fixture', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#506a80"/></svg>',
    }),
  )
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/image',
      name: '验收绑定',
      params: {},
      x: 500,
      y: 300,
    })
    const engine = window.__plein.engine as unknown as Engine
    const node = engine.doc.mutable(id)!
    node.set('results', [
      {
        id: 'review-result',
        runId: 'fixture',
        port: 'images',
        value: { type: 'image', assetId: 'review-fixture' },
        at: 1,
      },
    ])
    node.set('adopted', 'review-result')
    engine.doc.flush()
    return id
  })
  await clickElement(page, id)
  // 编辑器固定 840px 宽，窄窗口里右边的操作在窗口外：先把它移进来
  const full = page.getByRole('button', { name: '全屏查看', exact: true })
  await revealGenerator(page, full)
  await full.click()
  const viewer = page.getByRole('dialog', { name: '查看「验收绑定」', exact: true })
  const form = viewer.locator(`[data-review-node="${id}"]`)
  await form.locator('summary').first().click()
  const note = form.getByRole('textbox', { name: /创作验收备注/ })
  await note.fill('旧实例尚未保存的意见')
  await form.getByRole('checkbox', { name: '构图', exact: true }).check()
  return { id, viewer, form, note, errors }
}

for (const mode of ['readonly', 'replacement', 'rendered'] as const) {
  test(`创作验收 ${mode} 不保存失效草稿，恢复后可以重新记录`, async ({ page }) => {
    // 窄窗口要在审片面板打开之后再看：编辑器固定 840px 宽，390px 里点不到它右边的操作
    const f = await setup(page)
    if (mode === 'rendered') await page.setViewportSize({ width: 390, height: 640 })
    const button = f.form.getByRole('button', { name: '保存为可用', exact: true })
    await button.evaluate(
      (button, { id, mode }) => {
        const engine = window.__plein.engine as unknown as Engine
        if (mode === 'readonly') engine.doc.readOnly = true
        else
          engine.doc.ydoc.transact(
            () => engine.doc.elementMaps.set(id, engine.doc.mutable(id)!.clone()),
            engine.doc.origin,
          )
        if (mode !== 'rendered') (button as HTMLButtonElement).click()
        engine.doc.flush()
      },
      { id: f.id, mode },
    )
    expect(
      await page.evaluate(
        (id) => (window.__plein.engine as unknown as Engine).doc.get(id)!.reviews ?? [],
        f.id,
      ),
    ).toEqual([])
    if (mode === 'readonly') await expect(f.form.getByRole('alert')).toContainText('只读')
    else {
      await expect(f.note).toHaveValue('')
      await expect(f.form.getByRole('checkbox', { name: '构图', exact: true })).not.toBeChecked()
      await expect(f.viewer.getByRole('status')).toContainText('草稿已清除')
      await expect
        .poll(() => f.viewer.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true)
    }
    expect(f.errors).toEqual([])
    if (mode === 'readonly') {
      await page.evaluate((id) => {
        const engine = window.__plein.engine as unknown as Engine
        engine.doc.readOnly = false
        engine.doc.mutable(id)!.set('rotation', 1)
        engine.doc.flush()
      }, f.id)
    } else if (mode === 'replacement') {
      await expect(f.note).toHaveValue('')
    }
    await f.note.fill('确认当前素材后的意见')
    await f.form.getByRole('button', { name: '保存为需修改', exact: true }).click()
    await expect(f.form.locator('summary').first()).toContainText('需修改')
    expect(
      await page.evaluate(
        (id) => (window.__plein.engine as unknown as Engine).doc.get(id)!.reviews?.[0]?.note,
        f.id,
      ),
    ).toBe('确认当前素材后的意见')
    expect(f.errors).toEqual([])
    await f.form.screenshot({ path: test.info().outputPath('creative-review-recovered.png') })
    if (mode === 'rendered') {
      expect(await f.viewer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await f.viewer.screenshot({ path: test.info().outputPath('creative-review-mobile.png') })
    }
  })
}

test('同一实例的位置更新保留验收草稿，保存仍可撤销重做', async ({ page }) => {
  const f = await setup(page)
  await page.evaluate((id) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.doc.mutable(id)!.set('rotation', 15)
    engine.doc.flush()
    engine.doc.undo.stopCapturing()
  }, f.id)
  await expect(f.note).toHaveValue('旧实例尚未保存的意见')
  await f.form.getByRole('button', { name: '保存为可用', exact: true }).click()
  await expect(f.form.locator('summary').first()).toContainText('可用')
  await page.evaluate(() => (window.__plein.engine as unknown as Engine).undo())
  await expect(f.form.locator('summary').first()).toContainText('待审')
  await page.evaluate(() => (window.__plein.engine as unknown as Engine).redo())
  await expect(f.note).toHaveValue('旧实例尚未保存的意见')
  expect(
    await page.evaluate(
      (id) => (window.__plein.engine as unknown as Engine).doc.get(id)!.rotation,
      f.id,
    ),
  ).toBe(15)
  expect(f.errors).toEqual([])
})

test('来源删除时旧验收按钮不写入，撤销恢复后重新记录', async ({ page }) => {
  const f = await setup(page)
  await f.form.getByRole('button', { name: '保存为可用', exact: true }).evaluate((button, id) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.doc.undo.stopCapturing()
    engine.doc.ydoc.transact(() => engine.doc.elementMaps.delete(id), engine.doc.origin)
    ;(button as HTMLButtonElement).click()
    engine.doc.flush()
  }, f.id)
  await expect(f.form).toHaveCount(0)
  await expect(f.viewer.getByRole('status')).toContainText('来源节点已删除')
  expect(f.errors).toEqual([])
  await page.evaluate(() => (window.__plein.engine as unknown as Engine).undo())
  await f.form.locator('summary').first().click()
  await expect(f.note).toHaveValue('')
  await expect(f.form.getByRole('checkbox', { name: '构图', exact: true })).not.toBeChecked()
  await f.note.fill('删除恢复后重新确认')
  await f.form.getByRole('button', { name: '保存为可用', exact: true }).click()
  await expect(f.form.locator('summary').first()).toContainText('可用')
  expect(f.errors).toEqual([])
})
