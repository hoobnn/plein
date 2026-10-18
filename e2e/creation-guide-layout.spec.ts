import { expect, type Page, test } from '@playwright/test'
import { clickElement, newProject, zoomTo } from './canvas'

const guide = (page: Page) => page.getByTestId('creation-guide')
const readRight = (page: Page) =>
  page.evaluate(
    () =>
      (
        window.__plein.engine as typeof window.__plein.engine & {
          camera: { insets: { right: number } }
        }
      ).camera.insets.right,
  )
const noRuns = (page: Page) => {
  const requests: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/(?:run|run-flow|run-batch)(?:\?|$)/.test(r.url()))
      requests.push(r.url())
  })
  return requests
}
async function seed(page: Page) {
  const ids = await page.evaluate(() => {
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '布局引导分镜',
      x: 0,
      y: 0,
      params: {
        shots: [
          { id: 'one', no: 1, duration: 2, description: '第一镜' },
          { id: 'two', no: 2, duration: 2, description: '第二镜' },
        ],
      },
    })
    const text = window.__plein.addNode({
      type: 'plein/text',
      name: '保留的生成器正文',
      x: 600,
      y: 0,
      params: { text: '原始正文' },
    })
    return { board, text }
  })
  await zoomTo(page, [ids.text])
  await clickElement(page, ids.text)
  const generator = page.getByTestId('generator')
  if ((await generator.getAttribute('data-compact')) === 'true')
    await generator.getByRole('button', { name: /^编辑/ }).click()
  return {
    ...ids,
    generator,
    prompt: generator.getByRole('textbox', { name: '提示词', exact: true }),
  }
}

test('窄窗口引导独立打开，菜单 Esc、窗口切换和编辑器跳转均保留正文与选择', async ({ page }) => {
  await newProject(page)
  await page.setViewportSize({ width: 390, height: 700 })
  const requests = noRuns(page)
  const f = await seed(page)
  await expect(guide(page)).toHaveCount(0)
  await expect(f.prompt).toBeVisible()
  await f.prompt.fill('窄窗口保留的编辑内容 🌧️')
  const entry = page.getByRole('button', { name: '展开创作引导', exact: true })
  await expect(entry).toBeInViewport()
  expect(
    await entry.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return (
        r.right <= innerWidth &&
        el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      )
    }),
  ).toBe(true)
  await entry.click()
  const dialog = page.getByRole('dialog', { name: '创作下一步', exact: true })
  await expect(dialog).toBeVisible()
  const choose = guide(page).getByRole('combobox', { name: '创作引导试做镜头', exact: true })
  await choose.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(choose).toBeFocused()
  await choose.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.getByRole('option', { name: '镜头 2 · 第二镜', exact: true }).click()
  await expect(choose).toContainText('镜头 2')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => readRight(page)).toBe(360)
  await expect(choose).toContainText('镜头 2')
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(guide(page)).toHaveCount(0)
  await entry.click()
  await expect(choose).toContainText('镜头 2')
  await dialog.screenshot({
    path: test.info().outputPath('guide-mobile-dialog.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(entry).toBeFocused()
  await expect(f.prompt).toHaveValue('窄窗口保留的编辑内容 🌧️')
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.text])
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(page.getByRole('button', { name: '工作流', exact: true })).toBeVisible()
  await entry.click()
  await guide(page).locator('[data-guide-step="storyboard"]').getByRole('button').click()
  await expect(dialog).toHaveCount(0)
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(editor).toBeVisible()
  await expect.poll(() => editor.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.text, f.text)).toBe(
    '窄窗口保留的编辑内容 🌧️',
  )
  expect(requests).toEqual([])
})

test('宽窗口引导预留生成器空间，收起释放边距，任务面板开启时改用独立窗口', async ({ page }) => {
  await newProject(page)
  const requests = noRuns(page)
  const f = await seed(page)
  await expect.poll(() => readRight(page)).toBe(360)
  await expect(guide(page)).toBeVisible()
  await expect
    .poll(async () => {
      const a = await f.generator.boundingBox(),
        b = await guide(page).boundingBox()
      return !!a && !!b && a.x + a.width <= b.x
    })
    .toBe(true)
  await f.prompt.fill('宽窗口内容继续保留')
  await guide(page).getByRole('button', { name: '收起创作引导', exact: true }).click()
  await expect(guide(page)).toHaveCount(0)
  await expect.poll(() => readRight(page)).toBe(0)
  await page.getByRole('button', { name: '展开创作引导', exact: true }).click()
  await expect.poll(() => readRight(page)).toBe(360)
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect(guide(page)).toHaveCount(0)
  await expect.poll(() => readRight(page)).toBe(372)
  await page.getByRole('button', { name: '展开创作引导', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创作下一步', exact: true })
  await expect(dialog).toBeVisible()
  await guide(page).getByRole('button', { name: '收起创作引导', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '任务', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect.poll(() => readRight(page)).toBe(360)
  await expect(guide(page)).toBeVisible()
  await expect(f.prompt).toHaveValue('宽窗口内容继续保留')
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.text])
  expect(requests).toEqual([])
})
