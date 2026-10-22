import { expect, test } from '@playwright/test'
import { addNode, elements, newProject } from './canvas'

/** 内置智能体：不装 CLI，用 mock 的工具调用模型跑完一轮，再整轮撤销 */
test('内置小满建节点并运行，整轮撤销', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手' }).click()
  const panel = page.getByRole('complementary', { name: '助手' })
  await expect(panel.getByText('Mock 智能体').first()).toBeVisible()

  await panel.getByPlaceholder('让小满帮你做点什么…').fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送' }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const images = async () =>
    (await elements(page)).filter((e) => e.nodeType === 'plein/image').length
  await expect.poll(images).toBe(1)

  await panel.getByRole('button', { name: '撤销这一轮' }).click()
  await expect.poll(images).toBe(0)
})

/** 计划模式：先出计划卡片，同意后小满按步骤执行，逐步打勾 */
test('先出计划，同意后执行并打勾', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手' }).click()
  const panel = page.getByRole('complementary', { name: '助手' })
  const toggle = panel.getByRole('button', { name: '先出计划' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await panel.getByPlaceholder('让小满帮你做点什么…').fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送' }).click()
  await expect(panel.getByText('小满想这样做：新建一个生成图片节点并出图')).toBeVisible()
  const images = async () =>
    (await elements(page)).filter((e) => e.nodeType === 'plein/image').length
  // 同意之前不动画布
  expect(await images()).toBe(0)

  await panel.getByRole('button', { name: '同意并执行' }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  await expect(panel.locator('.plein-plan-step[data-status="done"]')).toHaveCount(2)
  await expect(panel.getByText('2/2')).toBeVisible()
  await expect.poll(images).toBe(1)
})

/** 修改方案：先出方案卡片，只改文字时不调用平台；整轮撤销回退文字，已有结果不丢 */
test('修改方案按范围批准：只改文字，再整轮撤销', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手' }).click()
  const panel = page.getByRole('complementary', { name: '助手' })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送' }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const image = async () => {
    const id = (await elements(page)).find((e) => e.nodeType === 'plein/image')!.id
    return page.evaluate((nodeId) => {
      const el = window.__plein.engine.doc.get(nodeId)!
      return { prompt: String(el.params?.prompt ?? ''), results: el.results?.length ?? 0 }
    }, id)
  }
  const before = await image()
  expect(before.results).toBe(1)

  await input.fill('让画面更紧张')
  await panel.getByRole('button', { name: '发送' }).click()
  const card = panel.locator('.plein-edit-plan')
  await expect(card).toContainText('小满的修改方案：让画面更紧张')
  await expect(card).toContainText('压迫感更强')
  await expect(card).toContainText('调用平台 1 次 · 价格未知')
  // 批准之前不动画布
  expect((await image()).prompt).toBe(before.prompt)

  await card.getByRole('button', { name: '只改文字' }).click()
  await expect(panel.getByText('【mock】方案已经按你选的范围执行。')).toBeVisible()
  await expect(card).toContainText('已执行只改文字，没有调用平台')
  await expect.poll(async () => (await image()).prompt).toContain('压迫感更强')
  expect((await image()).results).toBe(1)

  await panel.getByRole('button', { name: '撤销这一轮' }).last().click()
  await expect.poll(async () => (await image()).prompt).toBe(before.prompt)
  expect((await image()).results).toBe(1)
})

/** 逐项编辑方案：在卡片上把新提示词改成自己的写法，重新检查后按改过的方案只改文字 */
test('修改方案逐项编辑：改字段后重新检查，按改过的写法执行', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手' }).click()
  const panel = page.getByRole('complementary', { name: '助手' })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送' }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const prompt = async () => {
    const id = (await elements(page)).find((e) => e.nodeType === 'plein/image')!.id
    return page.evaluate(
      (nodeId) => String(window.__plein.engine.doc.get(nodeId)!.params?.prompt ?? ''),
      id,
    )
  }
  const before = await prompt()

  await input.fill('让画面更紧张')
  await panel.getByRole('button', { name: '发送' }).click()
  const card = panel.locator('.plein-edit-plan')
  await expect(card).toContainText('压迫感更强')
  await expect(card.getByRole('checkbox', { name: /运行/ })).toBeChecked()

  await card.locator('.plein-edit-change').hover()
  await card.getByRole('button', { name: /^改/ }).click()
  const field = card.getByRole('textbox')
  await field.fill(`${before}，只留一盏顶灯`)
  await card.getByRole('button', { name: '重新检查' }).click()
  await expect(card).toContainText('改过的修改方案：让画面更紧张')
  await expect(card).toContainText('只留一盏顶灯')
  await expect(card).not.toContainText('压迫感更强')
  // 不勾要运行的节点：完整方案也不调用平台
  await card.getByRole('checkbox', { name: /运行/ }).uncheck()
  await expect(card.locator('.plein-edit-cost').last()).toHaveText('不调用平台')
  expect(await prompt()).toBe(before)

  await card.getByRole('button', { name: '只改文字' }).click()
  await expect(panel.getByText('【mock】方案已经按你选的范围执行。')).toBeVisible()
  await expect.poll(prompt).toBe(`${before}，只留一盏顶灯`)
})

/** 多选工具条「让小满处理」：打开面板，带上选区，光标在输入框里 */
test('选区上让小满处理', async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本', { x: 360, y: 450 })
  await page.keyboard.press('Escape')
  await addNode(page, '文本', { x: 900, y: 450 })
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await elements(page)).length).toBe(2)
  await page.mouse.click(640, 120)
  await page.keyboard.press('ControlOrMeta+a')

  await page
    .getByRole('toolbar', { name: '多选操作' })
    .getByRole('button', { name: '让小满处理' })
    .click()
  const panel = page.getByRole('complementary', { name: '助手' })
  await expect(panel.getByText('带上选中的 2 个元素')).toBeVisible()
  await expect(panel.getByPlaceholder('让小满帮你做点什么…')).toBeFocused()
})
