import { expect, type Page, test } from './fixtures'
import {
  addNode,
  byName,
  centerOf,
  clickElement,
  contextMenu,
  deselect,
  newProject,
  showStoryboardCards,
  waitEngine,
  waitNode,
  zoomTo,
} from './canvas'

/** 分镜里第 i 个镜头展开出来的分镜图节点 */
const shotImage = (page: Page, i: number) =>
  page.evaluate((i) => {
    const doc = window.__plein.engine.doc
    const board = [...doc.elements()].find((e) => e.name === '分镜（双击展开镜头）')!
    const shot = (board as { params?: { shots?: Array<{ id: string }> } }).params!.shots![i]!
    const el = [...doc.elements()].find((e) => {
      const src = (e as { params?: { source?: { shot?: string; role?: string } } }).params?.source
      return src?.shot === shot.id && src.role === 'image'
    })!
    return { id: el.id, prompt: String((el as { params?: { prompt?: string } }).params?.prompt) }
  }, i)

test(
  '分镜表改了之后同步到已展开的节点：计划改的写进去，手改过的保留',
  { tag: '@core' },
  async ({ page }) => {
    const layoutErrors: string[] = []
    page.on('pageerror', (error) => {
      if (error.message.includes('ResizeObserver')) layoutErrors.push(error.message)
    })
    await newProject(page)
    await addNode(page, '短剧')
    const board = await byName(page, '分镜（双击展开镜头）')
    await zoomTo(page, [board.id])
    await contextMenu(page, board.id, '运行到此处')
    await waitNode(page, board.id)
    await expect(page.locator('.ui-toast')).toContainText('运行到「分镜（双击展开镜头）」运行完成')

    const openBoard = async () => {
      await deselect(page)
      await zoomTo(page, [board.id])
      const p = await centerOf(page, board.id)
      await page.mouse.dblclick(p.x, p.y)
      const dialog = page.getByRole('dialog', { name: '分镜表' })
      await expect(dialog).toBeVisible()
      await showStoryboardCards(dialog)
      return dialog
    }
    let dialog = await openBoard()
    await dialog.getByRole('button', { name: '展开为节点' }).click()
    await expect(page.locator('.ui-toast')).toContainText('已展开')

    // 用户在第二个镜头的分镜图节点上自己改了提示词
    const second = await shotImage(page, 1)
    await clickElement(page, second.id)
    await page.getByRole('textbox', { name: '提示词' }).fill('我自己写的第二镜')
    await page.keyboard.press('Escape')
    expect((await shotImage(page, 1)).prompt).toBe('我自己写的第二镜')

    // 分镜表里两个镜头的分镜图提示词都改了
    dialog = await openBoard()
    const durations = () =>
      dialog
        .getByLabel('时长')
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    const originalDurations = await durations()
    const prompts = dialog.getByLabel('分镜图提示词')
    await prompts.nth(0).fill('雨夜天台，林晚抱着铁盒回头')
    await prompts.nth(0).blur()
    await prompts.nth(1).fill('铁盒特写，锁扣崩开')
    await prompts.nth(1).blur()
    await expect(prompts.nth(0)).toHaveValue('雨夜天台，林晚抱着铁盒回头')
    await expect(prompts.nth(1)).toHaveValue('铁盒特写，锁扣崩开')
    expect(await durations()).toEqual(originalDurations)

    await dialog.getByRole('button', { name: /^查看差异/ }).click()
    const diff = page.getByRole('dialog', { name: '计划差异' })
    const shot1 = diff
      .getByRole('listitem')
      .filter({ has: page.getByText('镜头 01', { exact: true }) })
    const shot2 = diff
      .getByRole('listitem')
      .filter({ has: page.getByText('镜头 02', { exact: true }) })
    await expect(shot1.getByText('计划已改', { exact: true })).toBeVisible()
    await expect(shot2.getByText('你改过', { exact: true })).toBeVisible()
    await expect(diff.getByText('计划已改', { exact: true })).toHaveCount(1)
    await expect(diff.getByText('你改过', { exact: true })).toHaveCount(1)
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 700 })
      await expect(diff.getByRole('button', { name: '同步计划改动' })).toBeInViewport()
      expect(await diff.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      )
    }
    expect(layoutErrors).toEqual([])
    await diff.getByRole('button', { name: '同步计划改动' }).click()
    await expect(page.locator('.ui-toast')).toContainText(
      '已把计划同步到 1 个节点的 1 个字段，保留 1 处手改',
    )
    await expect(diff.getByText('没有待处理的差异')).toBeVisible()

    expect((await shotImage(page, 0)).prompt).toContain('雨夜天台，林晚抱着铁盒回头')
    expect((await shotImage(page, 1)).prompt).toBe('我自己写的第二镜')
  },
)

test(
  '双客户端的画面和台词冲突经明确选择后同步，不静默覆盖草稿',
  { tag: '@core' },
  async ({ page, context }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '协作分镜',
        x: 300,
        y: 200,
        params: {
          shots: [
            {
              id: 'one',
              no: 1,
              duration: 3,
              description: '原始画面',
              dialogue: [{ id: 'a', character: '甲', line: '原始台词' }],
            },
          ],
        },
      }),
    )
    const open = async (target: Page) => {
      await zoomTo(target, [id])
      const at = await centerOf(target, id)
      await target.mouse.dblclick(at.x, at.y)
      const dialog = target.getByRole('dialog', { name: '分镜表', exact: true })
      await expect(dialog).toBeVisible()
      await showStoryboardCards(dialog)
      return dialog
    }
    const local = await open(page)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      const remote = await open(peer)
      for (const [label, mine, theirs, choice] of [
        ['画面', '本机未提交画面😀', '同伴画面', '使用最新内容'],
        ['台词', '甲：本机未提交台词😀', '甲：同伴台词', '保留当前台词'],
      ]) {
        const input = local.getByRole('textbox', { name: label, exact: true })
        const peerInput = remote.getByRole('textbox', { name: label, exact: true })
        await input.fill(mine!)
        await peerInput.fill(theirs!)
        await peerInput.blur()
        await expect(local.getByRole('status')).toContainText(`${label}已在其他位置更新`)
        await input.blur()
        await expect(input).toHaveValue(mine!)
        await expect(peerInput).toHaveValue(theirs!)
        await local.getByRole('button', { name: choice, exact: true }).click()
        const final = choice === '使用最新内容' ? theirs! : mine!
        await expect(input).toHaveValue(final)
        await expect(peerInput).toHaveValue(final)
        await expect(input).toBeFocused()
      }
      await page.reload()
      await waitEngine(page)
      const reopened = await open(page)
      await expect(reopened.getByRole('textbox', { name: '画面', exact: true })).toHaveValue(
        '同伴画面',
      )
      await expect(reopened.getByRole('textbox', { name: '台词', exact: true })).toHaveValue(
        '甲：本机未提交台词😀',
      )
    } finally {
      await peerContext.close()
    }
  },
)

test('窄屏长分镜末镜可实际命中，原生撤销和引用定位保留编辑', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const target = window.__plein.addNode({
      type: 'plein/character',
      name: '引用角色',
      params: {},
      x: -600,
      y: 0,
    })
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '长分镜',
      x: 300,
      y: 200,
      params: {
        shots: Array.from({ length: 40 }, (_, i) => ({
          id: `long-${i}`,
          no: i + 1,
          duration: 3,
          description: `第${i + 1}镜画面。` + '雨后晨光落在透明玻璃杯上。'.repeat(5),
          imagePrompt: '保持主体环境一致。'.repeat(8),
        })),
      },
    })
    return { board, target }
  })
  await zoomTo(page, [ids.board])
  const at = await centerOf(page, ids.board)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
  await showStoryboardCards(dialog)
  await page.setViewportSize({ width: 390, height: 480 })
  const last = dialog.getByRole('article').last()
  const input = last.getByLabel('画面', { exact: true })
  await input.scrollIntoViewIfNeeded()
  await input.click()
  await input.fill('末镜 @引用角色。')
  await input.press('End')
  await input.pressSequentially('B')
  await input.press('ControlOrMeta+z')
  await expect(input).toHaveValue('末镜 @引用角色。')
  await input.press('ControlOrMeta+Shift+z')
  await expect(input).toHaveValue('末镜 @引用角色。B')
  await last.getByRole('checkbox', { name: '选择镜头 40', exact: true }).check()
  await last.getByRole('button', { name: '收起镜头 40', exact: true }).click()
  await last.getByRole('button', { name: '展开镜头 40', exact: true }).click()
  await expect(input).toHaveValue('末镜 @引用角色。B')
  await expect(last.getByRole('checkbox')).toBeChecked()
  await input.fill('末镜修改 @引用角色。')
  await input.scrollIntoViewIfNeeded()
  const mark = (await last.getByTestId('mention-highlights').locator('mark').first().boundingBox())!
  const box = (await input.boundingBox())!
  await input.click({
    position: { x: mark.x + mark.width / 2 - box.x, y: mark.y + mark.height / 2 - box.y },
    modifiers: ['ControlOrMeta'],
  })
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([ids.target])
  expect(
    await page.evaluate(
      (id) =>
        (window.__plein.engine.doc.get(id)!.params!.shots as { description: string }[]).at(-1)!
          .description,
      ids.board,
    ),
  ).toBe('末镜修改 @引用角色。')
})
