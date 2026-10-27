import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  return page.evaluate(() =>
    ['参考甲', '参考乙', '参考丙'].map((name, i) =>
      window.__plein.addNode({
        type: 'plein/text',
        name,
        params: { text: name },
        x: i * 500,
        y: 0,
      }),
    ),
  )
}

test('单选更换元素后恢复带上选区，发送的参考 ID 对应新元素', async ({ page }) => {
  const ids = await setup(page)
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids[0]!)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('使用现在选中的参考')
  await expect(panel.getByText('带上选中的 1 个元素', { exact: true })).toBeVisible()
  await page.getByRole('treeitem', { name: '参考乙 定位到画布', exact: true }).click()
  await panel.getByRole('button', { name: '不带选中元素', exact: true }).click()
  await expect(panel.getByText('带上选中的 1 个元素', { exact: true })).toHaveCount(0)
  await page.getByRole('treeitem', { name: '参考甲 定位到画布', exact: true }).click()
  await expect(panel.getByText('带上选中的 1 个元素', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '不带选中元素', exact: true }).click()
  await page.getByRole('treeitem', { name: '参考乙 定位到画布', exact: true }).click()
  await expect(panel.getByText('带上选中的 1 个元素', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('使用现在选中的参考')
  let sent: { selection?: string[]; text?: string } | undefined
  await page.route('**/api/agent/sessions/*/messages', (route) => {
    sent = route.request().postDataJSON() as typeof sent
    return route.fulfill({ status: 204 })
  })
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => sent?.selection).toEqual([ids[1]])
  expect(sent?.text).toBe('使用现在选中的参考')
})

test('相同选区的顺序变化保留排除选择，同数量换目标后恢复，主动排除时不发参考', async ({ page }) => {
  const ids = await setup(page)
  await page.evaluate((ids) => window.__plein.engine.selection.set(ids), [ids[0]!, ids[1]!])
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const chip = panel.getByText('带上选中的 2 个元素', { exact: true })
  await expect(chip).toBeVisible()
  await panel.getByRole('button', { name: '不带选中元素', exact: true }).click()
  await page.evaluate((ids) => window.__plein.engine.selection.set(ids), [ids[1]!, ids[0]!])
  await expect(chip).toHaveCount(0)
  await page.evaluate((ids) => window.__plein.engine.selection.set(ids), [ids[1]!, ids[2]!])
  await expect(chip).toBeVisible()
  await panel.getByRole('button', { name: '不带选中元素', exact: true }).click()
  await panel.getByPlaceholder('让小满帮你做点什么…').fill('这次明确不带参考')
  await panel.getByPlaceholder('让小满帮你做点什么…').press('Escape')
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await expect(chip).toHaveCount(0)
  await page.getByPlaceholder('让小满帮你做点什么…').press('Escape')
  await expect(panel).toHaveCount(0)
  await page.evaluate((ids) => window.__plein.engine.selection.set(ids), [ids[0]!, ids[2]!])
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await expect(chip).toBeVisible()
  await panel.getByRole('button', { name: '不带选中元素', exact: true }).click()
  await page.evaluate(() =>
    window.__plein.engine.zoomToFit(window.__plein.engine.selection.values()),
  )
  await page
    .getByRole('toolbar', { name: '多选操作', exact: true })
    .getByRole('button', { name: '让小满处理', exact: true })
    .click()
  await expect(chip).toBeVisible()
  await expect(panel.getByPlaceholder('让小满帮你做点什么…')).toHaveValue('这次明确不带参考')
  await panel.getByRole('button', { name: '不带选中元素', exact: true }).click()
  let sent: { selection?: string[]; text?: string } | undefined
  await page.route('**/api/agent/sessions/*/messages', (route) => {
    sent = route.request().postDataJSON() as typeof sent
    return route.fulfill({ status: 204 })
  })
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => sent?.text).toBe('这次明确不带参考')
  expect(sent?.selection).toBeUndefined()
})
