import { expect, test } from './fixtures'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'
import { slowFile } from './slow-file'

for (const change of ['delete', 'replace'] as const) {
  test(`3D 目标 ${change} 后关闭，迟到的输入不修改失效目标且撤销后可重开`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    await addNode(page, '3D 构图')
    const stage = (await elements(page)).find((el) => el.nodeType === 'plein/stage')!
    await page.keyboard.press('Escape')
    await zoomTo(page, [stage.id])
    const at = await centerOf(page, stage.id)
    await page.mouse.dblclick(at.x, at.y)
    const dialog = page.getByRole('dialog', { name: '3D 构图', exact: true })
    await expect(dialog.locator('.stage-canvas')).toBeVisible()
    const originalScene = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)!.params?.scene,
      stage.id,
    )
    await dialog.getByRole('spinbutton', { name: '左右', exact: true }).fill('7.25')
    await dialog.getByRole('button', { name: '添加人物', exact: true }).evaluate(
      (button, { id, change }) => {
        const engine = window.__plein
          .engine as unknown as import('../packages/canvas-core/src/engine').Engine
        engine.doc.undo.stopCapturing()
        if (change === 'delete') {
          engine.doc.ydoc.transact(() => engine.doc.elementMaps.delete(id), engine.doc.origin)
          engine.doc.flush()
        } else {
          engine.doc.ydoc.transact(
            () => engine.doc.mutable(id)!.set('nodeType', 'plein/text'),
            engine.doc.origin,
          )
          engine.doc.flush()
        }
        // 模拟目标变化后，同一帧旧按钮事件与输入失焦仍可能到达。
        ;(button as HTMLButtonElement).click()
      },
      { id: stage.id, change },
    )
    await expect(dialog).toHaveCount(0)
    const changed = await page.evaluate((id) => window.__plein.engine.doc.get(id), stage.id)
    if (change === 'delete') expect(changed).toBeUndefined()
    else {
      expect(changed?.nodeType).toBe('plein/text')
      expect(changed?.params?.scene).toEqual(originalScene)
    }
    expect(errors).toEqual([])
    await page.evaluate(() => {
      const engine = window.__plein
        .engine as unknown as import('../packages/canvas-core/src/engine').Engine
      engine.undo()
    })
    await expect
      .poll(async () => (await elements(page)).find((el) => el.id === stage.id)?.nodeType)
      .toBe('plein/stage')
    await expect(dialog).toHaveCount(0)
    await zoomTo(page, [stage.id])
    const restored = await centerOf(page, stage.id)
    await page.mouse.dblclick(restored.x, restored.y)
    await expect(dialog.getByRole('spinbutton', { name: '左右', exact: true })).toHaveValue('0')
    await dialog.getByRole('button', { name: '添加人物', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: '名字', exact: true })).toHaveValue('人物 2')
    expect(errors).toEqual([])
  })
}

test('同 ID 构图实例被替换时清除旧草稿，旧按钮不能修改新实例', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  await addNode(page, '3D 构图')
  const stage = (await elements(page)).find((el) => el.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const at = await centerOf(page, stage.id)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '3D 构图', exact: true })
  await expect(dialog.locator('.stage-canvas')).toBeVisible()
  await dialog.getByRole('spinbutton', { name: '左右', exact: true }).fill('7.25')
  await dialog.getByRole('button', { name: '添加人物', exact: true }).evaluate((button, id) => {
    const engine = window.__plein
      .engine as unknown as import('../packages/canvas-core/src/engine').Engine
    const replacement = engine.doc.mutable(id)!.clone()
    engine.doc.ydoc.transact(() => engine.doc.elementMaps.set(id, replacement), engine.doc.origin)
    engine.doc.flush()
    ;(button as HTMLButtonElement).click()
  }, stage.id)
  await expect(dialog.getByRole('spinbutton', { name: '左右', exact: true })).toHaveValue('0')
  await expect(dialog.getByRole('textbox', { name: '名字', exact: true })).toHaveValue('人物 1')
  await dialog.getByRole('button', { name: '添加人物', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '名字', exact: true })).toHaveValue('人物 2')
  await dialog.screenshot({ path: test.info().outputPath('replacement-recovered.png') })
  expect(errors).toEqual([])
})

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
