import { expect, test, type Page, type Locator } from '@playwright/test'
import type { StageScene, StageSnapshot } from '../packages/nodes/src/stage'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'

async function openStage(page: Page) {
  await newProject(page)
  await addNode(page, '3D 构图')
  const stage = (await elements(page)).find((element) => element.nodeType === 'plein/stage')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [stage.id])
  const point = await centerOf(page, stage.id)
  await page.mouse.dblclick(point.x, point.y)
  const dialog = page.getByRole('dialog', { name: '3D 构图', exact: true })
  await expect(dialog.locator('canvas.stage-canvas')).toBeVisible()
  const read = () =>
    page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.scene as StageScene, stage.id)
  return { id: stage.id, dialog, read }
}
async function midpoint(dialog: Locator) {
  const slider = dialog.getByRole('slider', { name: '预演时间', exact: true })
  await slider.press('Home')
  for (let n = 0; n < 5; n++) await slider.press('PageUp')
  await expect(slider).toHaveValue('2.5')
}

test('人物和机位关键帧支持插值、独立撤销、截图来源及恢复完整轨迹', async ({ page }) => {
  const { id, dialog, read } = await openStage(page)
  const sent: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(run|run-flow|run-batch|commit)$/.test(new URL(request.url()).pathname)
    )
      sent.push(request.url())
  })
  await dialog.getByRole('button', { name: '启用动态预演', exact: true }).click()
  await dialog.getByRole('slider', { name: '预演时间', exact: true }).press('End')
  const x = dialog.getByRole('spinbutton', { name: '左右', exact: true })
  await x.fill('2')
  await x.press('Enter')
  await dialog.getByRole('button', { name: '坐', exact: true }).click()
  await dialog.getByRole('button', { name: /35mm/ }).click()
  await dialog.getByRole('button', { name: '85', exact: true }).click()
  const ends = await read()
  expect(ends.motion!.keyframes.map((frame) => frame.time)).toEqual([0, 5])
  expect(ends.motion!.keyframes[1]!.figures[0]).toMatchObject({ x: 2, pose: 'sit' })
  await midpoint(dialog)
  await expect(dialog.getByRole('slider', { name: '焦距', exact: true })).toHaveValue('60')
  await dialog.getByRole('button', { name: /人物 1/ }).click()
  await expect(x).toHaveValue('1')
  expect(await read()).toEqual(ends)
  await dialog.getByRole('button', { name: '指向', exact: true }).click()
  expect((await read()).motion!.keyframes.map((frame) => frame.time)).toEqual([0, 2.5, 5])
  await dialog.getByRole('button', { name: '撤销构图操作', exact: true }).click()
  expect((await read()).motion!.keyframes).toHaveLength(2)
  await dialog.getByRole('button', { name: '重做构图操作', exact: true }).click()
  await dialog.getByRole('button', { name: '截图', exact: true }).click()
  await expect(dialog.getByRole('img', { name: /截图/ })).toHaveCount(1)
  const capture = await page.evaluate(
    (id) => (window.__plein.engine.doc.get(id)!.params!.snapshots as StageSnapshot[])[0]!,
    id,
  )
  expect(capture.time).toBe(2.5)
  expect(capture.scene.motion!.keyframes).toHaveLength(3)
  expect(capture.scene.motion!.keyframes[1]!.figures[0]!.pose).toBe('point')
  await dialog.screenshot({ path: test.info().outputPath('stage-keyframes.png') })
  await dialog.getByRole('slider', { name: '预演时间', exact: true }).press('End')
  await dialog.getByRole('button', { name: '行走', exact: true }).click()
  await dialog.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(dialog.getByRole('slider', { name: '预演时间', exact: true })).toHaveValue('2.5')
  expect((await read()).motion!.keyframes).toEqual(capture.scene.motion!.keyframes)
  expect(sent).toEqual([])
})

test('播放和拖动时间轴不写文档，锁定后可预览但不能修改或截图', async ({ page }) => {
  const { id, dialog, read } = await openStage(page)
  await dialog.getByRole('button', { name: '启用动态预演', exact: true }).click()
  await dialog.getByRole('spinbutton', { name: '预演时长', exact: true }).fill('1')
  const before = await read()
  await dialog.getByRole('button', { name: '播放预演', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '暂停预演', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '截图', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '播放预演', exact: true })).toBeVisible()
  expect(await read()).toEqual(before)
  await page.evaluate((id) => {
    const node = window.__plein.engine.doc.mutable(id)! as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('locked', true)
  }, id)
  await expect(dialog.getByRole('status')).toContainText('只读')
  await expect(dialog.getByRole('button', { name: '记录当前关键帧', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '截图', exact: true })).toBeDisabled()
  await dialog.getByRole('slider', { name: '预演时间', exact: true }).press('Home')
  await dialog.getByRole('button', { name: '播放预演', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '播放预演', exact: true })).toBeVisible()
  expect(await read()).toEqual(before)
})
