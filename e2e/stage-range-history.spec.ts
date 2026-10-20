import { expect, test } from '@playwright/test'
import { stageSceneOf } from '../packages/nodes/src/stage'
import { addNode, centerOf, elements, newProject, zoomTo } from './canvas'

for (const field of ['宽', '焦距'] as const) {
  test(`3D ${field} 连续两次拖动分别撤销，同次停顿保留为一步`, async ({ page }) => {
    await newProject(page)
    await addNode(page, '3D 构图')
    const stage = (await elements(page)).find((el) => el.nodeType === 'plein/stage')!
    await page.keyboard.press('Escape')
    await zoomTo(page, [stage.id])
    const at = await centerOf(page, stage.id)
    await page.mouse.dblclick(at.x, at.y)
    const dialog = page.getByRole('dialog', { name: '3D 构图', exact: true })
    await expect(dialog.locator('.stage-canvas')).toBeVisible()
    if (field === '宽') {
      await dialog.getByRole('button', { name: '添加场景件', exact: true }).click()
      await page.getByRole('menuitem', { name: '桌子', exact: true }).click()
    } else await dialog.getByRole('button', { name: /mm ·/ }).click()
    const read = async () => {
      const scene = stageSceneOf(
        await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, stage.id),
      )
      return field === '宽' ? scene.blocks[0]!.w : scene.camera.focal
    }
    const slider = dialog.getByRole('slider', { name: field, exact: true })
    const drag = async (fraction: number, pause = false) => {
      const rect = (await slider.boundingBox())!
      const min = Number(await slider.getAttribute('min'))
      const max = Number(await slider.getAttribute('max'))
      const value = Number(await slider.inputValue())
      const x = rect.x + 8 + (rect.width - 16) * ((value - min) / (max - min))
      const y = rect.y + rect.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(rect.x + rect.width * fraction, y, { steps: 5 })
      if (pause) {
        // 确实跨过归并窗口，不通过缩短全局时间设置来代替真实停顿。
        await page.waitForTimeout(450)
        await page.mouse.move(rect.x + rect.width * (fraction + 0.1), y, { steps: 4 })
      }
      await page.mouse.up()
    }
    const initial = await read()
    await drag(0.35)
    const first = await read()
    expect(first).not.toBe(initial)
    await drag(0.65, true)
    const second = await read()
    expect(second).not.toBe(first)
    const undo = dialog.getByRole('button', { name: '撤销构图操作', exact: true })
    const redo = dialog.getByRole('button', { name: '重做构图操作', exact: true })
    await undo.click()
    expect(await read()).toBe(first)
    await undo.click()
    expect(await read()).toBe(initial)
    await redo.click()
    expect(await read()).toBe(first)
    await redo.click()
    expect(await read()).toBe(second)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.mouse.dblclick(at.x, at.y)
    await expect(dialog.locator('.stage-canvas')).toBeVisible()
    expect(await read()).toBe(second)
    await dialog.screenshot({ path: test.info().outputPath('separate-range-gestures.png') })
  })
}
