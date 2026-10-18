import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('数值参数保留零值、失焦夹紧范围，清空恢复默认且不会自动生成', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/llm',
      name: '温度边界',
      params: { model: 'plein/mock:chat', prompt: '数字参数测试' },
      x: 0,
      y: 0,
    }),
  )
  await page.getByRole('treeitem', { name: '温度边界 定位到画布', exact: true }).click()
  let submitted = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(r.url())) submitted++
  })
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '编辑LLM', exact: true }).click()
  await generator.getByRole('button', { name: '参数', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '参数', exact: true })
  await panel.getByRole('button', { name: '更多参数', exact: true }).click()
  const number = panel.getByRole('spinbutton', { name: '温度', exact: true })
  const slider = panel.getByRole('slider', { name: '温度', exact: true })
  const box = (await panel.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(8)
  expect(box.x + box.width).toBeLessThanOrEqual(792)
  await expect(number).toBeInViewport()
  const read = () =>
    page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.temperature, id)
  for (const [typed, expected] of [
    ['0', 0],
    ['2.8', 2],
    ['-0.2', 0],
    ['1.25', 1.25],
  ] as const) {
    await number.fill(typed)
    await number.press('Enter')
    await expect.poll(read).toBe(expected)
    await expect(number).toHaveValue(String(expected))
    await expect(slider).toHaveValue(String(expected))
  }
  await slider.focus()
  await slider.press('ArrowRight')
  await expect.poll(read).toBe(1.27)
  await expect(number).toHaveValue('1.27')
  await expect(slider).toHaveValue('1.27')
  await number.fill('')
  await number.blur()
  await expect.poll(read).toBeUndefined()
  await expect(number).toHaveAttribute('placeholder', '0.7')
  await expect(slider).toHaveValue('0.7')
  await page.keyboard.press('Escape')
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)
      return r.ok() ? (await r.json()).params.temperature : null
    })
    .toBe(0.7)
  expect(submitted).toBe(0)
})

test('平台整数设置夹紧上下界并取整，清空可恢复平台默认', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  await settings.getByRole('button', { name: /^Mock（开发测试用）/ }).click()
  const input = settings.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })
  for (const [typed, expected] of [
    ['-1', '0'],
    ['60001', '60000'],
    ['1.6', '2'],
  ] as const) {
    await input.fill(typed)
    await input.press('Tab')
    await expect(input).toHaveValue(expected)
  }
  await input.fill('')
  await input.pressSequentially('-')
  await input.press('Tab')
  await expect(input).toHaveValue('2')
  await expect(settings.getByRole('alert')).toContainText('请输入有效数字')
  await input.fill('')
  await input.press('Tab')
  await expect(input).toHaveValue('')
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await settings.getByRole('button', { name: '保存', exact: true }).click()
  await expect(settings.getByText('已保存', { exact: true })).toBeVisible()
  const config = await (await page.request.get('/api/providers/plein/mock/config')).json()
  // 配置保存用户覆盖项；清空后删掉覆盖，由 Provider 的 schema 默认值接管。
  expect(config.settings.latencyMs).toBeUndefined()
})

for (const incomplete of ['1e', '-']) {
  test(`数值草稿 ${incomplete} 不误当清空，失焦保留已有参数并可恢复输入`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/llm',
        name: '未完成数值',
        x: 0,
        y: 0,
        params: { model: 'plein/mock:chat', prompt: '保留已有参数', temperature: 1.1 },
      }),
    )
    await page.getByRole('treeitem', { name: '未完成数值 定位到画布', exact: true }).click()
    await page
      .getByTestId('generator')
      .getByRole('button', { name: '编辑LLM', exact: true })
      .click()
    await page.getByRole('button', { name: '参数', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '参数', exact: true })
    await panel.getByRole('button', { name: '更多参数', exact: true }).click()
    const number = panel.getByRole('spinbutton', { name: '温度', exact: true })
    await number.fill('')
    await number.pressSequentially(incomplete)
    expect(await number.evaluate((el: HTMLInputElement) => el.validity.badInput)).toBe(true)
    await number.press('Tab')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.temperature, id),
    ).toBe(1.1)
    await expect(number).toHaveValue('1.1')
    await expect(number).toHaveAttribute('aria-invalid', 'true')
    await expect(panel.getByRole('alert')).toContainText('请输入有效数字')
    await expect(number).toHaveAccessibleDescription(/请输入有效数字/)
    if (incomplete === '1e')
      await panel.screenshot({
        path: test.info().outputPath('invalid-number.png'),
        animations: 'disabled',
      })
    await number.fill('1.3')
    await number.press('Enter')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.temperature, id),
    ).toBe(1.3)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(number).not.toHaveAttribute('aria-invalid', 'true')
    await number.fill('')
    await number.pressSequentially(incomplete)
    await number.press('Tab')
    const slider = panel.getByRole('slider', { name: '温度', exact: true })
    await slider.focus()
    await slider.press('ArrowRight')
    await expect(number).toHaveValue('1.32')
    await expect(panel.getByRole('alert')).toHaveCount(0)
  })
}
