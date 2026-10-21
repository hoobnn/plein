import { expect, type Locator, type Page, test } from '@playwright/test'
import { article, checkpointPair, panel } from './checkpoints'

const preview = (page: Page) => panel(page).getByTestId('checkpoint-preview')
const label = (page: Page) => preview(page).getByText('预览原稿 第二版正文', { exact: true })

async function measure(page: Page) {
  const text = await label(page).boundingBox()
  const canvas = await preview(page).locator('canvas').boundingBox()
  expect(text).not.toBeNull()
  expect(canvas).not.toBeNull()
  return {
    width: text!.width,
    centerX: canvas!.x + canvas!.width / 2 - text!.x,
    centerY: canvas!.y + canvas!.height / 2 - text!.y,
  }
}
async function withinCanvas(target: Locator) {
  await expect(target).toBeInViewport({ ratio: 1 })
  expect(
    await target.evaluate((el) => {
      const text = el.getBoundingClientRect()
      const canvas = el
        .closest('[data-testid="checkpoint-preview"]')!
        .querySelector('canvas')!
        .getBoundingClientRect()
      return (
        text.left >= canvas.left &&
        text.right <= canvas.right &&
        text.top >= canvas.top &&
        text.bottom <= canvas.bottom
      )
    }),
  ).toBe(true)
}

for (const initialWidth of [1440, 320]) {
  test(`从 ${initialWidth}px 打开检查点，适应预览随窗口尺寸保持内容可见`, async ({ page }) => {
    await page.setViewportSize({ width: initialWidth, height: initialWidth === 320 ? 700 : 900 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const f = await checkpointPair(page)
    await article(page, f.second.name)
      .getByRole('button', { name: '只读预览', exact: true })
      .click()
    await expect(preview(page).getByRole('button', { name: '适应画布', exact: true })).toBeEnabled()
    await expect(label(page)).toBeVisible()
    await withinCanvas(label(page))
    for (const width of [390, 320, 1100, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 700 : 900 })
      await expect(label(page)).toBeVisible()
      await expect
        .poll(async () => {
          const text = await label(page).boundingBox()
          const canvas = await preview(page).locator('canvas').boundingBox()
          return (
            !!text &&
            !!canvas &&
            text.x >= canvas.x &&
            text.x + text.width <= canvas.x + canvas.width &&
            text.y >= canvas.y &&
            text.y + text.height <= canvas.y + canvas.height
          )
        })
        .toBe(true)
      if (width === 320)
        await panel(page).screenshot({
          path: test.info().outputPath('checkpoint-resize-mobile.png'),
          animations: 'disabled',
        })
    }
    await preview(page).getByRole('button', { name: '适应画布', exact: true }).click()
    await withinCanvas(label(page))
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(errors).toEqual([])
  })
}

test('手动缩放和平移后调整预览窗口，保留用户的缩放与查看中心，适应画布可重新开启自动适应', async ({
  page,
}) => {
  const f = await checkpointPair(page)
  await article(page, f.second.name).getByRole('button', { name: '只读预览', exact: true }).click()
  await expect(label(page)).toBeVisible()
  const canvas = preview(page).locator('canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const initial = await measure(page)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -20)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await measure(page)).width).toBeGreaterThan(initial.width)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20, { steps: 6 })
  await page.mouse.up({ button: 'middle' })
  // 再次按下停止松手惯性，测量已经稳定的手动视角。
  await page.mouse.click(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20)
  // 缩放和平移带缓动，连续两次测量一致才算视角已经停稳。
  let before = await measure(page)
  await expect
    .poll(async () => {
      const prev = before
      await page.waitForTimeout(150)
      before = await measure(page)
      return (
        before.width === prev.width &&
        before.centerX === prev.centerX &&
        before.centerY === prev.centerY
      )
    })
    .toBe(true)
  await page.setViewportSize({ width: 1100, height: 800 })
  await expect
    .poll(async () => {
      const after = await measure(page)
      return (
        Math.abs(after.width - before.width) < 1 &&
        Math.abs(after.centerX - before.centerX) < 1 &&
        Math.abs(after.centerY - before.centerY) < 1
      )
    })
    .toBe(true)
  await preview(page).getByRole('button', { name: '适应画布', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(label(page)).toBeVisible()
  await expect
    .poll(async () => {
      const r = await label(page).boundingBox()
      return !!r && r.x >= 0 && r.x + r.width <= 390
    })
    .toBe(true)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
})
