import { expect, test } from '@playwright/test'
import { elements, newProject } from './canvas'

for (const choice of ['允许', '跳过', '停止'] as const) {
  test(`每次运行确认保持待答复，删除恢复后可${choice}且结果符合选择`, async ({ page }) => {
    await newProject(page)
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    await panel.getByRole('combobox', { name: '确认方式', exact: true }).click()
    await page.getByRole('option', { name: '每次运行和删除都先问我', exact: true }).click()
    await panel.getByPlaceholder('让小满帮你做点什么…').fill('画一张雨夜天台')
    await panel.getByRole('button', { name: '发送', exact: true }).click()
    const card = panel.locator('.plein-agent-approval').filter({ hasText: '需要你确认：' })
    const allow = card.getByRole('button', { name: '允许', exact: true })
    await expect(allow).toBeEnabled()
    const id = (await elements(page)).find((e) => e.nodeType === 'plein/image')!.id
    await expect.poll(async () => (await elements(page)).find((e) => e.id === id)?.results).toBe(0)
    await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible()
    const locate = card.getByRole('button', { name: '在画布上查看', exact: true })
    await expect(locate).toBeVisible()
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), id)
    await page
      .locator('canvas')
      .first()
      .evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await elements(page)).some((e) => e.id === id)).toBe(false)
    await expect(locate).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await elements(page)).some((e) => e.id === id)).toBe(true)
    await expect(locate).toBeVisible()
    if (choice === '停止') await panel.getByRole('button', { name: '停止', exact: true }).click()
    else await card.getByRole('button', { name: choice, exact: true }).click()
    if (choice === '允许') {
      await expect(panel.getByText('【mock】好了')).toBeVisible()
      await expect
        .poll(async () => (await elements(page)).find((e) => e.id === id)?.results)
        .toBe(1)
      await expect(panel.getByText(/已允许：/)).toBeVisible()
    } else if (choice === '跳过') {
      await expect(panel.getByText('【mock】这次运行没有执行，已保留创建的节点。')).toBeVisible()
      expect((await elements(page)).find((e) => e.id === id)?.results).toBe(0)
      await expect(panel.getByText(/已跳过：/)).toBeVisible()
    } else {
      await expect(panel.getByText('本轮对话已停止', { exact: true })).toBeVisible()
      await expect(panel.getByText(/已过期：/)).toBeVisible()
      expect((await elements(page)).find((e) => e.id === id)?.results).toBe(0)
    }
    await page.screenshot({
      path: test.info().outputPath('approval-choice.png'),
      animations: 'disabled',
    })
  })
}

test('计划确认与每次运行确认串行等待，完成后计划步骤正确结束', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  await panel.getByRole('combobox', { name: '确认方式', exact: true }).click()
  await page.getByRole('option', { name: '每次运行和删除都先问我', exact: true }).click()
  await panel.getByRole('button', { name: '先出计划', exact: true }).click()
  await panel.getByPlaceholder('让小满帮你做点什么…').fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  const plan = panel.locator('.plein-agent-plan')
  await plan.getByRole('button', { name: '同意并执行', exact: true }).click()
  const run = panel.locator('.plein-agent-approval').filter({ hasText: '需要你确认：' })
  await expect(plan.locator('.plein-plan-step').nth(1)).toHaveAttribute('data-status', 'doing')
  await run.getByRole('button', { name: '允许', exact: true }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  await expect(plan.getByText('2/2', { exact: true })).toBeVisible()
  await expect(plan.locator('.plein-plan-step[data-status="done"]')).toHaveCount(2)
})

test('批准前用户修改了节点提示词，旧方案拒绝执行并保留新文字与已有结果', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const node = (await elements(page)).find((e) => e.nodeType === 'plein/image')!
  const before = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)?.results?.map((r) => r.id),
    node.id,
  )
  await input.fill('让画面更紧张')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  const card = panel.locator('.plein-edit-plan')
  await expect(card.getByRole('button', { name: '只改文字', exact: true })).toBeEnabled()
  await page.getByRole('treeitem', { name: `${node.name} 定位到画布`, exact: true }).click()
  const prompt = page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('用户手动写的新场景，不允许被旧方案覆盖')
  const peer = await page.context().newPage()
  try {
    await peer.goto(page.url())
    await expect
      .poll(() =>
        peer.evaluate((id) => window.__plein?.engine.doc.get(id)?.params?.prompt, node.id),
      )
      .toBe('用户手动写的新场景，不允许被旧方案覆盖')
    await card.getByRole('button', { name: '只改文字', exact: true }).click()
    await expect(card).toHaveAttribute('data-status', 'stale')
    await expect(card).toContainText('旧方案没有执行')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, node.id),
    ).toBe('用户手动写的新场景，不允许被旧方案覆盖')
    expect(
      await page.evaluate(
        (id) => window.__plein.engine.doc.get(id)?.results?.map((r) => r.id),
        node.id,
      ),
    ).toEqual(before)
  } finally {
    await peer.close()
  }
})
