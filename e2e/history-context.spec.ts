import { expect, test } from '@playwright/test'
import { elements, newProject, waitNode } from './canvas'

for (const next of ['edit', 'reopen', 'escape'] as const) {
  test(`历史素材读取期间${next === 'escape' ? '按 Esc 关闭' : next === 'edit' ? '关闭并编辑其他卡片' : '关闭并重新打开历史'}，完成后不抢上下文`, async ({
    page,
  }) => {
    await newProject(page)
    const ids = await page.evaluate(() => ({
      source: window.__plein.addNode({
        type: 'plein/image',
        name: '慢速历史图片',
        params: { model: 'plein/mock:image', prompt: '海鸟' },
        x: -1000,
        y: -1000,
      }),
      other: window.__plein.addNode({
        type: 'plein/text',
        name: '继续编辑的文本',
        params: { text: '保留当前编辑' },
        x: 400,
        y: 250,
      }),
    }))
    const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvas}/nodes/${ids.source}/input`)).status(),
      )
      .toBe(200)
    expect(
      (
        await page.request.post(`/api/canvases/${canvas}/nodes/${ids.source}/run`, { data: {} })
      ).status(),
    ).toBe(202)
    await waitNode(page, ids.source)
    let held = false
    let release = () => {}
    await page.route('**/api/assets/*/meta', async (route) => {
      const response = await route.fetch()
      await new Promise<void>((resolve) => {
        release = resolve
        held = true
      })
      await route.fulfill({ response })
    })
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '生成历史', exact: true })
    await history.getByRole('checkbox').first().check()
    await history.getByRole('button', { name: '放到画布上', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    if (next === 'escape') await page.keyboard.press('Escape')
    else await history.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(history).toBeHidden()
    if (next === 'edit') {
      await page.getByRole('treeitem', { name: '继续编辑的文本 定位到画布', exact: true }).click()
      await page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
        .fill('等待期间继续编辑')
    } else if (next === 'reopen')
      await page.getByRole('button', { name: '生成历史', exact: true }).click()
    release()
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'image').length)
      .toBe(1)
    if (next !== 'reopen') {
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual(
        next === 'edit' ? [ids.other] : [],
      )
      if (next === 'edit')
        await expect(
          page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true }),
        ).toHaveValue('等待期间继续编辑')
      await page.getByRole('button', { name: '定位新素材', exact: true }).click()
      const imported = (await elements(page)).find((el) => el.kind === 'image')!
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
        imported.id,
      ])
    } else {
      await expect(history).toBeVisible()
      await expect(history.getByRole('checkbox').first()).not.toBeChecked()
      await history.getByRole('checkbox').first().check()
      await expect(history.getByRole('checkbox').first()).toBeChecked()
    }
  })
}
