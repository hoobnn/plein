import { expect, test } from './fixtures'
import { clickElement, deselect, edgesInto, elements, handleOf, newProject } from './canvas'

test('视频共用连接点列出视频和尾帧，创建序列连接主视频输出', async ({ page }) => {
  await newProject(page)
  const source = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/video',
      name: '多输出连接来源',
      params: {},
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, source)
  await deselect(page)
  const point = await handleOf(page, source, 'out')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(1150, 500, { steps: 5 })
  await page.mouse.up()
  const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
  const search = menu.getByRole('textbox', { name: '搜索节点' })
  await expect(search).toHaveAttribute('placeholder', '连接「视频 / 尾帧」')
  await search.fill('序列')
  await menu.getByRole('option', { name: '序列', exact: true }).click()
  const target = (await elements(page)).find((el) => el.nodeType === 'plein/sequence')!
  await expect.poll(() => edgesInto(page, target.id)).toEqual([[source, 'video', 'clips']])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await elements(page)).length).toBe(1)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(() => edgesInto(page, target.id)).toEqual([[source, 'video', 'clips']])
})

for (const resize of [false, true]) {
  test(`添加节点菜单${resize ? '打开后缩小窗口' : '在低高度窗口打开'}，搜索和候选均可操作`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: resize ? 900 : 320 })
    await newProject(page)
    await page.mouse.dblclick(950, resize ? 700 : 200)
    const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
    const search = menu.getByRole('textbox', { name: '搜索节点' })
    await expect(search).toBeFocused()
    if (resize) await page.setViewportSize({ width: 1000, height: 320 })
    await expect
      .poll(async () => {
        const box = await menu.boundingBox()
        return box ? box.y + box.height : Infinity
      })
      .toBeLessThanOrEqual(312)
    const count = await menu.getByRole('option').count()
    for (let i = 1; i < count; i++) await search.press('ArrowDown')
    await expect(menu.getByRole('option', { selected: true })).toBeInViewport({ ratio: 1 })
    await search.fill('不存在的节点xyz')
    await expect(menu.getByText('没有匹配的节点')).toBeVisible()
    await search.press('Enter')
    expect(await elements(page)).toHaveLength(0)
    await search.fill('文本')
    await expect(menu.getByRole('option', { selected: true })).toHaveText('文本')
    await expect(menu).toHaveCSS('opacity', '1')
    await page.screenshot({ path: `test-results/node-picker-${resize ? 'resize' : 'small'}.png` })
    await menu.getByRole('option', { selected: true }).click()
    await expect(menu).toHaveCount(0)
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.nodeType === 'plein/text').length)
      .toBe(1)
  })
}

test('小窗口从文本拉线创建图片节点，取消不改文档，创建与连线可一起撤销重做', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 320 })
  await newProject(page)
  const source = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '连接来源',
      params: { text: '保留来源' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, source)
  await deselect(page)
  const original = await elements(page)
  const open = async () => {
    const point = await handleOf(page, source, 'out')
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(950, 150, { steps: 5 })
    await page.mouse.up()
  }
  const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
  await open()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  expect(await elements(page)).toEqual(original)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual([])
  await open()
  await menu.getByRole('textbox', { name: '搜索节点' }).fill('生成图片')
  await menu.getByRole('option', { name: '生成图片', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await elements(page)).length).toBe(2)
  const target = (await elements(page)).find((el) => el.nodeType === 'plein/image')!
  await expect.poll(() => edgesInto(page, target.id)).toEqual([[source, 'text', 'prompt']])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => elements(page)).toEqual(original)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual([])
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(() => edgesInto(page, target.id)).toEqual([[source, 'text', 'prompt']])
  expect(await elements(page)).toHaveLength(2)
})
