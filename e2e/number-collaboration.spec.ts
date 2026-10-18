import { expect, type Page, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

for (const choice of ['latest', 'draft'] as const) {
  test(`数值草稿遇到同帧更新不覆盖，明确选择 ${choice} 后继续编辑`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/llm',
        name: '数值冲突',
        x: 0,
        y: 0,
        params: { model: 'plein/mock:chat', prompt: '数值协作', temperature: 1.1 },
      }),
    )
    await page.getByRole('treeitem', { name: '数值冲突 定位到画布', exact: true }).click()
    await page
      .getByTestId('generator')
      .getByRole('button', { name: '编辑LLM', exact: true })
      .click()
    await page.getByRole('button', { name: '参数', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '参数', exact: true })
    await panel.getByRole('button', { name: '更多参数', exact: true }).click()
    const number = panel.getByRole('spinbutton', { name: '温度', exact: true })
    await number.fill('1.6')
    await number.evaluate((input: HTMLInputElement, id) => {
      const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
        set(key: string, value: unknown): void
      }
      params.set('temperature', 0.4)
      input.blur()
    }, id)
    const read = () =>
      page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.temperature, id)
    expect(await read()).toBe(0.4)
    await expect(number).toHaveValue('1.6')
    await expect(panel.getByRole('status')).toContainText('0.4')
    if (choice === 'latest') {
      await panel.getByRole('button', { name: '使用最新数值', exact: true }).click()
      await expect(number).toHaveValue('0.4')
      expect(await read()).toBe(0.4)
    } else {
      await panel.getByRole('button', { name: '保留当前数值', exact: true }).click()
      await expect(number).toHaveValue('1.6')
      expect(await read()).toBe(1.6)
    }
    await expect(number).toBeFocused()
    await expect(panel.getByRole('status')).toHaveCount(0)
    await number.fill('1.2')
    await number.press('Enter')
    expect(await read()).toBe(1.2)
  })
}

async function openNumber(page: Page) {
  await page.getByRole('treeitem', { name: '数值冲突 定位到画布', exact: true }).click()
  await page.getByTestId('generator').getByRole('button', { name: '编辑LLM', exact: true }).click()
  await page.getByRole('button', { name: '参数', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '参数', exact: true })
  await panel.getByRole('button', { name: '更多参数', exact: true }).click()
  return panel
}

test('两个客户端数值协作：干净输入跟随更新，草稿冲突可保留并同步', async ({ page, context }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/llm',
      name: '数值冲突',
      x: 0,
      y: 0,
      params: { model: 'plein/mock:chat', prompt: '双端数值', temperature: 1.1 },
    }),
  )
  const local = await openNumber(page)
  const number = local.getByRole('spinbutton', { name: '温度', exact: true })
  const peerContext = await context.browser()!.newContext({ viewport: { width: 800, height: 560 } })
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
    const other = (await openNumber(peer)).getByRole('spinbutton', { name: '温度', exact: true })
    await other.fill('0.8')
    await other.press('Enter')
    await expect(number).toHaveValue('0.8')
    await number.fill('1.6')
    await other.fill('0.4')
    await other.press('Enter')
    await expect(local.getByRole('status')).toContainText('0.4')
    await number.press('Tab')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.temperature, id),
    ).toBe(0.4)
    await expect(number).toHaveValue('1.6')
    for (const name of ['使用最新数值', '保留当前数值'])
      await expect(local.getByRole('button', { name, exact: true })).toBeInViewport()
    await local.screenshot({
      path: test.info().outputPath('number-conflict.png'),
      animations: 'disabled',
    })
    await local.getByRole('button', { name: '保留当前数值', exact: true }).click()
    await expect(number).toBeFocused()
    await expect(other).toHaveValue('1.6')
    await expect(local.getByRole('status')).toHaveCount(0)
  } finally {
    await peerContext.close()
  }
})
