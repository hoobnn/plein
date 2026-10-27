import { expect, type Page, test } from './fixtures'
import {
  addNode,
  clickElement,
  edgesInto,
  elements,
  handleOf,
  newProject,
  revealGenerator,
  waitEngine,
} from './canvas'

/**
 * 生成器里只能由真浏览器证明的几条：
 * 拖线连接节点（真实鼠标命中与画布连线）、
 * 角色名称在同伴改名时的冲突处理（两个浏览器上下文的同步）。
 */

const nodes = async (page: Page) => (await elements(page)).filter((e) => e.kind === 'node')

async function character(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/character',
      name: '协作角色',
      params: {},
      x: 400,
      y: 200,
    }),
  )
  await page.getByRole('treeitem', { name: '协作角色 定位到画布', exact: true }).click()
  return id
}

const nameField = (page: Page) => page.getByRole('textbox', { name: '节点名称', exact: true })
const savedName = (page: Page, id: string) =>
  page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)

test(
  '角色名称远端更新不覆盖未提交草稿，用户可明确选择名称',
  { tag: '@core' },
  async ({ page, context }) => {
    const id = await character(page)
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      await expect.poll(() => savedName(peer, id)).toBe('协作角色')
      await nameField(page).fill('我的未提交名称')
      const rename = async (before: string, after: string) => {
        await peer.getByRole('treeitem', { name: `${before} 定位到画布`, exact: true }).dblclick()
        const input = peer.getByRole('tree').getByRole('textbox', { name: '元素名称', exact: true })
        await input.fill(after)
        await input.press('Enter')
        await expect.poll(() => savedName(page, id)).toBe(after)
      }
      await rename('协作角色', '同伴已保存名称')
      await expect(nameField(page)).toHaveValue('我的未提交名称')
      const panel = page.getByTestId('generator')
      await expect(panel.getByRole('status')).toContainText('同伴已保存名称')
      // 冲突时失焦不应无意覆盖同伴刚提交的名称。
      await nameField(page).blur()
      await expect.poll(() => savedName(page, id)).toBe('同伴已保存名称')
      // 用户可以明确选择保留本机草稿。
      await panel.getByRole('button', { name: '保留当前输入' }).click()
      await expect.poll(() => savedName(page, id)).toBe('我的未提交名称')
    } finally {
      await peerContext.close()
    }
  },
)

test('拖线连接节点，撤销重做连线与删除', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '文本', { x: 360, y: 450 })
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
  await page.keyboard.press('Escape')
  await addNode(page, '生成图片', { x: 1000, y: 450 })
  await expect.poll(async () => (await nodes(page)).length).toBe(2)
  await page.keyboard.press('Escape')
  const all = await nodes(page)
  const text = all.find((e) => e.nodeType === 'plein/text')!
  const image = all.find((e) => e.nodeType === 'plein/image')!

  // 从文本的输出口拖到生成图片的输入口：按类型自动接到提示词
  const from = await handleOf(page, text.id, 'out')
  const to = await handleOf(page, image.id, 'in')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, to.y, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => edgesInto(page, image.id)).toEqual([[text.id, 'text', 'prompt']])

  // 撤销 / 重做连线
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => edgesInto(page, image.id)).toEqual([])
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(() => edgesInto(page, image.id)).toHaveLength(1)

  // 删除文本节点连线一起没了；撤销后节点和连线都回来
  await clickElement(page, text.id)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
  await expect.poll(() => edgesInto(page, image.id)).toEqual([])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await nodes(page)).length).toBe(2)
  await expect.poll(() => edgesInto(page, image.id)).toHaveLength(1)
})

/**
 * 只能由真浏览器证明的障碍场景：真实命中测试、真实焦点顺序、真实滚动与布局。
 * 只测必要的一两档窗口尺寸，保留功能断言，不写固定间距这类样式断言。
 */

// 低高度窗口：输出端口仍能命中并拖线；缩窗后弹层仍可操作、焦点能返回
test('低窗口下端口仍能拖线，缩窗后弹层可操作且焦点返回', { tag: '@core' }, async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 560 })
  await newProject(page)
  const ids = await page.evaluate(() => ({
    text: window.__plein.addNode({
      type: 'plein/text',
      name: '低窗文本',
      params: { text: '连线' },
      x: 200,
      y: 200,
    }),
    image: window.__plein.addNode({
      type: 'plein/image',
      name: '低窗图片',
      params: {},
      x: 600,
      y: 200,
    }),
  }))
  await page.waitForFunction(
    (ids) =>
      window.__plein.engine.doc.get(ids.image) !== undefined &&
      window.__plein.engine.doc.get(ids.text) !== undefined,
    ids,
  )
  await page.keyboard.press('Escape')

  // 低窗口下端口仍要能命中：拖线真的连上
  const from = await handleOf(page, ids.text, 'out')
  const to = await handleOf(page, ids.image, 'in')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, to.y, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => edgesInto(page, ids.image)).toHaveLength(1)

  // 弹层在缩窗后仍可操作，关掉后焦点回到触发它的按钮
  await clickElement(page, ids.image)
  await revealGenerator(page)
  const panel = page.getByTestId('generator')
  await panel.getByRole('button', { name: '参数', exact: true }).click()
  const popover = page.getByRole('dialog', { name: '参数', exact: true })
  await expect(popover).toBeVisible()
  await page.setViewportSize({ width: 760, height: 480 })
  await expect(popover).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '参数', exact: true })).toBeFocused()
})

// 平移与缩窗：正在编辑的正文不收起，名称草稿不提前提交
test('平移与缩窗时输入框不收起，名称草稿不提前提交', { tag: '@core' }, async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 620 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/character',
      name: '编辑中的节点',
      params: { prompt: '初始提示词' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  await revealGenerator(page)
  const panel = page.getByTestId('generator')
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.click()
  await prompt.fill('正在编辑的正文')
  // 名称草稿：只改了输入框，不提交
  const name = panel.getByRole('textbox', { name: '节点名称', exact: true })
  await name.fill('改名草稿')

  // 平移画布：编辑器不收起，输入内容还在
  await page.evaluate(() => {
    const engine = window.__plein.engine as Window['__plein']['engine'] & {
      camera: { panBy(x: number, y: number): void }
    }
    engine.camera.panBy(120, 60)
  })
  await expect(panel).toBeVisible()
  await expect(prompt).toHaveValue('正在编辑的正文')

  // 缩小窗口：编辑器仍在，正文没被收起
  await page.setViewportSize({ width: 780, height: 480 })
  await expect(panel).toBeVisible()
  await expect(prompt).toHaveValue('正在编辑的正文')

  // 名称草稿还没写进文档
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)).toBe(
    '编辑中的节点',
  )
})

// 输入框里按 Esc：先退出输入框，再按一次取消选中并收起面板
test('输入框里按 Esc 先退出输入，再按取消选中', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '两级 Escape',
      params: { prompt: '雨夜天台' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  await revealGenerator(page)
  const prompt = page.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.click()
  await prompt.fill('雨夜天台')
  await prompt.press('Escape')
  await expect(prompt).not.toBeFocused()
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values().length))
    .toBe(1)
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values().length))
    .toBe(0)
  await expect(prompt).toBeHidden()
  // 正文已经保存，没有因为取消选中丢掉
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, id)).toBe(
    '雨夜天台',
  )
})
