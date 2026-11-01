import { expect, test } from './fixtures'
import { addNode, newProject } from './canvas'

test('双指平移进入展开窗口后继续，停顿后恢复窗口交互', async ({ page }) => {
  await newProject(page)
  await addNode(page, '生成图片', { x: 720, y: 240 })
  const editor = page.getByTestId('node-editor')
  await expect(editor).toBeVisible()
  await page.evaluate(() => {
    const engine = window.__plein.engine
    const rect = engine.doc.worldRect(engine.selection.values()[0]!)
    const at = engine.worldToClient(rect.x, rect.y + rect.h)
    engine.camera.panBy(600 - at.x, 300 - at.y)
  })
  await expect.poll(async () => (await editor.boundingBox())!.y).toBeCloseTo(312, 0)
  const box = (await editor.boundingBox())!
  const x = box.x + box.width + 20
  const y = box.y + 100
  const cameraX = () =>
    page.evaluate(() => (window.__plein.engine.camera as unknown as { x: number }).x)
  const before = await cameraX()
  await page.mouse.move(x, y)
  await page.mouse.wheel(-100, 0)
  await expect.poll(cameraX).toBeCloseTo(before + 100, 0)
  await page.mouse.move(x + 1, y)
  expect(
    await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.plein-node-editor'),
      { x: x + 1, y },
    ),
  ).toBe(true)
  await page.mouse.wheel(-80, 0)
  await expect.poll(cameraX).toBeCloseTo(before + 180, 0)
  // 一次手势结束后，新的窗口内滚动不能再带动画布。
  await page.waitForTimeout(250)
  const beforeY = await page.evaluate(
    () => (window.__plein.engine.camera as unknown as { y: number }).y,
  )
  await page.mouse.wheel(0, 80)
  await page.waitForTimeout(50)
  expect(await cameraX()).toBeCloseTo(before + 180, 0)
  expect(
    await page.evaluate(() => (window.__plein.engine.camera as unknown as { y: number }).y),
  ).toBe(beforeY)
  const prompt = editor.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('窗口恢复编辑')
  await expect(prompt).toHaveValue('窗口恢复编辑')
})

test('画布平移跨过节点编辑器边缘后持续响应', async ({ page }) => {
  await newProject(page)
  await addNode(page, '生成图片', { x: 720, y: 240 })
  const editor = page.getByTestId('node-editor')
  await expect(editor).toBeVisible()
  await page.evaluate(() => {
    const engine = window.__plein.engine
    const id = engine.selection.values()[0]!
    const rect = engine.doc.worldRect(id)
    const at = engine.worldToClient(rect.x, rect.y + rect.h)
    engine.camera.panBy(460 - at.x, 300 - at.y)
  })
  await expect.poll(async () => (await editor.boundingBox())!.y).toBeCloseTo(312, 0)
  for (const mode of ['right', 'middle', 'space', 'hand'] as const) {
    await page.evaluate(() => window.__plein.engine.camera.panBy(0, 0))
    if (mode === 'hand')
      await page.evaluate(() =>
        (window.__plein.engine as unknown as { setTool(t: string): void }).setTool('hand'),
      )
    if (mode === 'space') await page.keyboard.down('Space')
    const box = (await editor.boundingBox())!
    const x = box.x + box.width + 20
    const y = box.y + 40
    const before = await page.evaluate(() => {
      const c = window.__plein.engine.camera as unknown as { x: number; y: number }
      return { x: c.x, y: c.y }
    })
    await page.mouse.move(x, y)
    await page.mouse.down({
      button: mode === 'right' ? 'right' : mode === 'middle' ? 'middle' : 'left',
    })
    await page.mouse.move(x - 200, y, { steps: 10 })
    const after = await page.evaluate(
      () => (window.__plein.engine.camera as unknown as { x: number }).x,
    )
    await page.mouse.up({
      button: mode === 'right' ? 'right' : mode === 'middle' ? 'middle' : 'left',
    })
    if (mode === 'space') await page.keyboard.up('Space')
    expect(after - before.x, mode).toBeCloseTo(-200, 0)
  }
})
