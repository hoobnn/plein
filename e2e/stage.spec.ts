import { expect, test } from '@playwright/test'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'

/** E1 3D 构图：摆人物和姿态，截图写成节点结果；改场景不动已有截图，重新截图产生新结果 */
test('3D 构图：摆人物、截图成为节点结果', async ({ page }) => {
  await newProject(page)
  await addNode(page, '3D 构图')
  await expect
    .poll(async () => (await elements(page)).some((e) => e.nodeType === 'plein/stage'))
    .toBe(true)
  const stage = (await elements(page)).find((e) => e.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const at = await centerOf(page, stage.id)
  // 添加菜单正在退场时，透明定位容器也不能挡住紧接着的画布双击。
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, at)).toBe(
    'CANVAS',
  )
  await page.mouse.dblclick(at.x, at.y)

  const dialog = page.getByRole('dialog', { name: '3D 构图' })
  await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
  await dialog.getByRole('button', { name: '添加人物' }).click()
  await expect(dialog.getByRole('button', { name: /人物 2/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await dialog.getByRole('button', { name: '指向' }).click()
  await expect(dialog.getByRole('button', { name: /人物 2\s*指向/ })).toBeVisible()

  const results = async () => (await elements(page)).find((e) => e.id === stage.id)!.results
  expect(await results()).toBe(0)
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect.poll(results).toBe(1)
  await expect(dialog.getByRole('img', { name: /截图/ })).toHaveCount(1)

  // 来源记在节点上：截图时的场景（两个人物，第二个在指）和版本
  const source = await page.evaluate((id) => {
    const el = window.__plein.engine.doc.get(id)!
    const shots = el.params?.snapshots as Array<{
      rev: number
      scene: { figures: Array<{ pose: string }> }
    }>
    return { rev: shots[0]!.rev, poses: shots[0]!.scene.figures.map((f) => f.pose) }
  }, stage.id)
  expect(source.poses).toEqual(['stand', 'point'])

  // 继续改场景：已有截图不变；再截一张是新结果
  await dialog.getByRole('button', { name: '坐' }).click()
  expect(await results()).toBe(1)
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect.poll(results).toBe(2)
  await expect(dialog.getByRole('img', { name: /截图/ })).toHaveCount(2)
  // 延迟真实 PNG 编码回调：期间继续摆姿态并采用旧图，检查来源与采用均不被迟到截图覆盖。
  const before = await page.evaluate(
    (id) => ({
      ...window.__plein.engine.doc.get(id)!,
      adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
    }),
    stage.id,
  )
  await page.evaluate(() => {
    const state = { ready: false, finish: () => {} }
    ;(window as unknown as { stageCapture: typeof state }).stageCapture = state
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      HTMLCanvasElement.prototype.toBlob = original
      original.call(
        this,
        (blob) => {
          state.finish = () => callback(blob)
          state.ready = true
        },
        ...args,
      )
    }
  })
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { stageCapture: { ready: boolean } }).stageCapture.ready,
      ),
    )
    .toBe(true)
  await dialog.getByRole('button', { name: '行走', exact: true }).click()
  await dialog.locator('.stage-shot').last().getByRole('button').first().click()
  const chosen = await page.evaluate(
    (id) => window.__plein.engine.doc.mutable(id)?.get('adopted'),
    stage.id,
  )
  expect(chosen).not.toBe(before.adopted)
  await page.evaluate(() =>
    (window as unknown as { stageCapture: { finish(): void } }).stageCapture.finish(),
  )
  await expect.poll(results).toBe(3)
  await expect(page.locator('.ui-toast')).toContainText('保存为候选，当前采用的画面未改变')
  const after = await page.evaluate(
    (id) => ({
      ...window.__plein.engine.doc.get(id)!,
      adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
    }),
    stage.id,
  )
  expect(after.adopted).toBe(chosen)
  const captured = (after.params!.snapshots as Array<{ rev: number; scene: unknown }>)[0]!
  expect(captured.scene).toEqual(before.params!.scene)
  expect(captured.rev).toBe((before.params!.scene as { rev: number }).rev)
  expect(after.params!.scene).not.toEqual(captured.scene)
  await page.evaluate(() => {
    delete (window as unknown as { stageCapture?: unknown }).stageCapture
  })
  if (process.env.STAGE_SHOTS) {
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${process.env.STAGE_SHOTS}/editor.png` })
  }
})
