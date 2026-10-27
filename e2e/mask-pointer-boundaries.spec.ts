import { expect, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
for (const [tool, end] of [
  ['框选', 'cancel'],
  ['画笔', 'cancel'],
  ['橡皮', 'cancel'],
  ['框选', 'blur'],
  ['框选', 'capture'],
  ['框选', 'foreign'],
] as const) {
  test(`蒙版 ${tool} ${end} 只处理当前指针，取消保留已完成笔画`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const upload = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png' },
      data: Buffer.from(solidPng(160, 96, [100, 140, 180])),
    })
    expect(upload.status()).toBe(201)
    const asset = (await upload.json()) as { id: string }
    const id = await page.evaluate((assetId) => {
      const engine = window.__plein.engine as unknown as Engine
      engine.paste({
        plein: 1,
        edges: [],
        elements: [
          {
            id: 'source',
            kind: 'image',
            name: '蒙版指针原图',
            assetId,
            x: 400,
            y: 300,
            w: 240,
            h: 144,
            z: 'a0',
            rotation: 0,
            locked: false,
            parentId: null,
          },
        ],
      })
      const id = [...engine.doc.elements()][0]!.id
      engine.selection.set([id])
      return id
    }, asset.id)
    await zoomTo(page, [id])
    await page.getByRole('button', { name: '局部重绘', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '画重绘区域', exact: true })
    const canvas = dialog.getByTestId('mask-canvas')
    await expect(canvas).toBeVisible()
    await dialog.getByRole('button', { name: '框选', exact: true }).click()
    let box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.15)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 4 })
    await page.mouse.up()
    const done = dialog.getByRole('button', { name: '完成', exact: true })
    await expect(done).toBeEnabled()
    await dialog.getByRole('button', { name: tool, exact: true }).click()
    const baseline = await canvas.evaluate(
      (el: HTMLCanvasElement) =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.toDataURL()))),
        ),
    )
    box = (await canvas.boundingBox())!
    const start = tool === '橡皮' ? [0.2, 0.25] : [0.6, 0.2]
    const finish = tool === '橡皮' ? [0.4, 0.35] : [0.8, 0.6]
    await page.mouse.move(box.x + box.width * start[0]!, box.y + box.height * start[1]!)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * finish[0]!, box.y + box.height * finish[1]!, {
      steps: 4,
    })
    await expect
      .poll(() => canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL()))
      .not.toBe(baseline)
    if (end === 'foreign') {
      const preview = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())
      await canvas.dispatchEvent('pointerdown', { pointerId: 77, button: 0 })
      await canvas.dispatchEvent('pointermove', {
        pointerId: 77,
        clientX: box.x + box.width * 0.95,
        clientY: box.y + box.height * 0.9,
      })
      await canvas.dispatchEvent('pointerup', { pointerId: 77 })
      expect(await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(preview)
      await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.7)
      await page.mouse.up()
      await expect
        .poll(() => canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL()))
        .not.toBe(preview)
      await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    } else {
      if (end === 'cancel') await canvas.dispatchEvent('pointercancel', { pointerId: 1 })
      else if (end === 'capture') await canvas.evaluate((el) => el.releasePointerCapture(1))
      else await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.8)
      await page.mouse.up()
    }
    await expect
      .poll(
        async () => (await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())) === baseline,
      )
      .toBe(true)
    await expect(done).toBeEnabled()
    if (tool === '框选' && end === 'cancel')
      await page.screenshot({ path: testInfo.outputPath('cancelled-draft.png') })
    await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(done).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '清空', exact: true })).toBeDisabled()
    expect(errors).toEqual([])
  })
}
