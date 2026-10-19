import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

async function fixture(page: Page, long = false, overridden = false) {
  await newProject(page)
  const before = long ? 'OriginalToken'.repeat(100) + '\n展开时第二行' : '初始分镜图'
  const after = long ? 'PlannedToken'.repeat(100) + '\n计划第二行' : '更新的分镜图'
  const board = await page.evaluate(
    (before) =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '差异阅读测试',
        x: 300,
        y: 200,
        params: {
          shots: [
            {
              id: 'shot-1',
              no: 1,
              duration: 3,
              description: '画面',
              imagePrompt: before,
              motionPrompt: '静止',
              dialogue: [{ id: 'line-1', character: '小岚', line: '初始台词' }],
            },
          ],
        },
      }),
    before,
  )
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  const open = async () => {
    await zoomTo(page, [board])
    const at = await centerOf(page, board)
    await page.mouse.dblclick(at.x, at.y)
    await expect(editor).toBeVisible()
  }
  await open()
  await editor.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const ids = await page.evaluate(
    ({ board, long, overridden }) => {
      const nodes = [...window.__plein.engine.doc.elements()].filter(
        (el) => (el.params?.source as { storyboard?: string })?.storyboard === board,
      )
      const image = nodes.find((el) => (el.params?.source as { role?: string })?.role === 'image')!
      const speech = nodes.find(
        (el) => (el.params?.source as { role?: string })?.role === 'speech',
      )!
      if (long)
        (
          window.__plein.engine.doc.mutable(image.id) as unknown as {
            set(key: string, value: unknown): void
          }
        ).set('name', 'LongNodeName'.repeat(50))
      if (overridden) {
        const params = window.__plein.engine.doc.mutable(speech.id)!.get('params') as {
          set(key: string, value: unknown): void
        }
        params.set('text', '')
        params.set('voice', { provider: 'custom-provider', voiceId: 'custom-voice' })
      }
      return { image: image.id, speech: speech.id }
    },
    { board, long, overridden },
  )
  await open()
  const prompt = editor.getByLabel('分镜图提示词', { exact: true })
  await prompt.fill(after)
  await prompt.blur()
  await editor.getByRole('button', { name: /^查看差异/ }).click()
  const panel = page.getByRole('dialog', { name: '计划差异', exact: true })
  await expect(panel).toBeVisible()
  return { board, ids, panel }
}

for (const width of [1440, 390]) {
  test(`${width}px 长英文和多行差异完整换行，只需纵向滚动`, async ({ page }) => {
    const f = await fixture(page, true)
    await page.setViewportSize({ width, height: 700 })
    const body = f.panel.locator('.ui-scrollbar')
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const row = f.panel
      .locator(`[data-node-id="${f.ids.image}"]`)
      .getByRole('listitem', { name: '提示词差异', exact: true })
    await expect(row.getByText('当前节点', { exact: true })).toBeVisible()
    await expect(row.getByText('分镜计划', { exact: true })).toBeVisible()
    const actual = row.locator('dd').filter({ hasText: '展开时第二行' })
    expect(await actual.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await expect(
      f.panel.getByRole('button', { name: '同步计划改动', exact: true }),
    ).toBeInViewport()
    await expect(f.panel.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
    await page.screenshot({
      path: test.info().outputPath(`diff-long-${width}.png`),
      animations: 'disabled',
    })
  })
}

test('手改空台词和自定义音色明确显示当前值与计划值，同步保留手改', async ({ page }) => {
  const f = await fixture(page, false, true)
  const speech = f.panel.locator(`[data-node-id="${f.ids.speech}"]`)
  const text = speech.getByRole('listitem', { name: '台词差异', exact: true })
  const voice = speech.getByRole('listitem', { name: '音色差异', exact: true })
  const current = (row: ReturnType<typeof speech.getByRole>) =>
    row
      .locator('dt')
      .filter({ hasText: /^当前节点$/ })
      .evaluate((el) => el.nextElementSibling?.textContent)
  expect(await current(text)).toBe('（空）')
  expect(await current(voice)).toContain('custom-voice')
  await expect(text.getByText('你改过', { exact: true })).toBeVisible()
  await expect(text.getByText('展开时', { exact: true })).toBeVisible()
  await f.panel.getByRole('button', { name: '同步计划改动', exact: true }).click()
  const params = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)?.params,
    f.ids.speech,
  )
  expect(params?.text).toBe('')
  expect(params?.voice).toEqual({ provider: 'custom-provider', voiceId: 'custom-voice' })
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, f.ids.image),
  ).toContain('更新的分镜图')
})
