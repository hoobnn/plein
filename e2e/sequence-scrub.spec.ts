import { expect, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

for (const cancel of ['pointercancel', 'blur'] as const) {
  test(`播放头拖动收到 ${cancel} 后不再跟随鼠标，其他指针不影响当前拖动`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const sequence = await page.evaluate(() => {
      const video = window.__plein.addNode({
        type: 'plein/video',
        name: '待生成镜头',
        params: {},
        x: 0,
        y: 0,
      })
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: '播放头取消测试',
        params: {},
        x: 600,
        y: 0,
      })
      window.__plein.connect([video, 'video'], [id, 'clips'])
      return id
    })
    await zoomTo(page, [sequence])
    const at = await centerOf(page, sequence)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const time = editor.locator('.seq-time')
    const sc = (await editor.locator('.seq-scroll').boundingBox())!
    const ruler = (await editor.locator('.seq-ruler').boundingBox())!
    const x = sc.x + sc.width * 0.4
    const y = ruler.y + ruler.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y, { steps: 4 })
    const active = await time.innerText()
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 })))
    await page.mouse.move(x + 100, y, { steps: 4 })
    await expect(time).not.toHaveText(active)
    const before = await time.innerText()
    await page.evaluate(
      (kind) =>
        window.dispatchEvent(
          kind === 'blur' ? new Event('blur') : new PointerEvent('pointercancel', { pointerId: 1 }),
        ),
      cancel,
    )
    await page.mouse.move(x + 180, y, { steps: 4 })
    await page.mouse.up()
    await expect(time).toHaveText(before)
    await page.mouse.click(x, y)
    await expect(time).not.toHaveText(before)
    const finished = await time.innerText()
    await page.mouse.move(x + 200, y)
    await expect(time).toHaveText(finished)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 100, y, { steps: 4 })
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
    await page.mouse.move(x + 200, y)
    await page.mouse.up()
    await page.mouse.dblclick(at.x, at.y)
    await expect(time).toHaveText('0:00.0 / 0:02.0')
    await page.mouse.move(x + 200, y)
    await expect(time).toHaveText('0:00.0 / 0:02.0')
    expect(errors).toEqual([])
  })
}
