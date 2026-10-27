import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { addNode, edgesInto, elements, newProject, revealGenerator, waitNode } from './canvas'

/** 设了就把界面截图存到这个目录（亮色、暗色各一张） */
const shotDir = process.env.PLEIN_E2E_SHOTS

async function shoot(page: Page, name: string) {
  if (!shotDir) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shotDir, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

test(
  '局部重绘：在图上框选、涂抹出区域，接出局部重绘节点并生成',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    await addNode(page, '生成图片')
    const generator = page.getByTestId('generator')
    await generator.locator('textarea').first().fill('窗边的书桌，桌上有一只白色杯子')
    // 编辑器固定在卡片下方，控件可能在窗口外：先把它移进窗口
    const generate = generator.getByRole('button', { name: '生成', exact: true })
    await revealGenerator(page, generate)
    await generate.click()
    const [image] = (await elements(page)).filter((e) => e.kind === 'node')
    await waitNode(page, image!.id)

    await generator.getByRole('button', { name: '局部重绘' }).click()
    const dialog = page.getByRole('dialog', { name: '画重绘区域' })
    await expect(dialog).toBeVisible()
    const board = dialog.getByTestId('mask-canvas')
    await expect(board).toBeVisible()
    const box = (await board.boundingBox())!
    // 框一块，再用画笔补一笔
    await dialog.getByRole('button', { name: '框选' }).click()
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.35)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.75, { steps: 8 })
    await page.mouse.up()
    await dialog.getByRole('button', { name: '画笔' }).click()
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.7, { steps: 10 })
    await page.mouse.up()
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.3)
    await shoot(page, '1-mask')
    await dialog.getByRole('button', { name: '完成' }).click()
    await expect(dialog).toBeHidden()

    const edit = (await elements(page)).find((e) => e.nodeType === 'plein/image-edit')!
    expect(edit).toBeTruthy()
    const [edge] = await edgesInto(page, edit.id)
    expect(edge).toEqual([image!.id, 'images', 'image'])
    const mask = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.params?.mask as Record<string, unknown>,
      edit.id,
    )
    expect(mask).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
    await expect(page.getByTestId('mask-field')).toContainText('高亮处会被重画')

    await generator.locator('textarea').first().fill('把杯子换成红色马克杯')
    await page.mouse.move(700, 120)
    await shoot(page, '2-node')
    await revealGenerator(page, generate)
    await generate.click()
    await waitNode(page, edit.id)
    await page.mouse.move(700, 120)
    await shoot(page, '3-result')
  },
)
