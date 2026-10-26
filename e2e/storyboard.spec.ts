import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  byName,
  centerOf,
  clickElement,
  contextMenu,
  deselect,
  newProject,
  showStoryboardCards,
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
    await diff.getByRole('button', { name: '同步计划改动' }).click()
    await expect(page.locator('.ui-toast')).toContainText(
      '已把计划同步到 1 个节点的 1 个字段，保留 1 处手改',
    )
    await expect(diff.getByText('没有待处理的差异')).toBeVisible()

    expect((await shotImage(page, 0)).prompt).toContain('雨夜天台，林晚抱着铁盒回头')
    expect((await shotImage(page, 1)).prompt).toBe('我自己写的第二镜')
  },
)
