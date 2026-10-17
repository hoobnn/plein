import { expect, type Page, test } from '@playwright/test'
import { addNode, byName, centerOf, contextMenu, newProject, waitNode, zoomTo } from './canvas'

async function openBoard(page: Page) {
  await newProject(page)
  await addNode(page, '短剧')
  const { id: boardId } = await byName(page, '分镜（双击展开镜头）')
  await zoomTo(page, [boardId])
  await contextMenu(page, boardId, '运行到此处')
  await waitNode(page, boardId)
  await expect(page.locator('.ui-toast')).toContainText('运行到「分镜（双击展开镜头）」运行完成')
  await zoomTo(page, [boardId])
  const center = await centerOf(page, boardId)
  await page.mouse.dblclick(center.x, center.y)
  const dialog = page.getByRole('dialog', { name: '分镜表' })
  await expect(dialog).toBeVisible()
  return { boardId, dialog }
}

test('同一帧内提交分镜文本并调整另一行时长，两处改动都保留', async ({ page }) => {
  const { boardId, dialog } = await openBoard(page)
  await dialog.getByLabel('分镜图提示词').nth(2).fill('铁盒特写，雨水顺着锁扣往下流')

  // number spinner 的一次操作会先让文本失焦，再提交数字变更；两次写入可早于文档的下一帧通知。
  await dialog
    .getByLabel('时长')
    .first()
    .evaluate((input) => {
      ;(document.activeElement as HTMLTextAreaElement).blur()
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, '3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

  const read = () =>
    page.evaluate((id) => {
      const shots = window.__plein.engine.doc.get(id)!.params!.shots as Array<{
        duration: number
        imagePrompt: string
      }>
      return { duration: shots[0]!.duration, imagePrompt: shots[2]!.imagePrompt }
    }, boardId)
  await expect.poll(read).toEqual({
    duration: 3,
    imagePrompt: '铁盒特写，雨水顺着锁扣往下流',
  })
})

test('分镜时长超出范围、清空重输不会让镜头消失或丢失文本', async ({ page }) => {
  const { boardId, dialog } = await openBoard(page)
  const count = await dialog.getByRole('article').count()
  const shot = dialog.getByRole('article').first()
  const description = await shot.getByLabel('画面', { exact: true }).inputValue()
  const duration = shot.getByLabel('时长', { exact: true })
  await duration.fill('31')
  await duration.blur()
  await expect(dialog.getByRole('article')).toHaveCount(count)
  await expect(duration).toHaveValue('30')
  await duration.fill('-2')
  await duration.blur()
  await expect(duration).toHaveValue('1')
  await duration.fill('')
  await expect(duration).toHaveValue('')
  await duration.blur()
  await expect(duration).toHaveValue('1')
  await duration.fill('2.5')
  await duration.blur()
  await expect(duration).toHaveValue('2.5')
  await expect(shot.getByLabel('画面', { exact: true })).toHaveValue(description)
  expect(
    await page.evaluate((id) => {
      const shots = window.__plein.engine.doc.get(id)!.params!.shots as { duration: number }[]
      return shots[0]!.duration
    }, boardId),
  ).toBe(2.5)
  const second = dialog.getByRole('article').nth(1).getByLabel('画面', { exact: true })
  await second.fill('其他镜头编辑后仍保留第一镜')
  await second.blur()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()
  const at = await centerOf(page, boardId)
  await page.mouse.dblclick(at.x, at.y)
  await expect(dialog.getByRole('article')).toHaveCount(count)
  await expect(duration).toHaveValue('2.5')
  await expect(shot.getByLabel('画面', { exact: true })).toHaveValue(description)
})

test('同一镜头两句台词在下一帧前连续提交，保留两句修改和身份', async ({ page }) => {
  const { boardId, dialog } = await openBoard(page)
  const row = dialog.getByRole('article').first()
  await row.getByLabel('台词').first().fill('林晚：第一句\n老周：第二句')
  await row.getByLabel('台词').first().blur()
  await expect(row.getByLabel('台词')).toHaveCount(2)
  const read = () =>
    page.evaluate((id) => {
      const shots = window.__plein.engine.doc.get(id)!.params!.shots as Array<{
        dialogue: Array<{ id: string; character: string; line: string }>
      }>
      return shots[0]!.dialogue
    }, boardId)
  const before = await read()
  await row.getByLabel('台词').first().fill('林晚：第一句已修改')
  await row.evaluate(async (element) => {
    const inputs = element.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="台词"]')
    inputs[0]!.blur()
    inputs[1]!.focus()
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setValue.call(inputs[1], '老周：第二句已修改')
    inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    // React 提交第二句的本地草稿，但文档的 requestAnimationFrame 通知尚未到来。
    await Promise.resolve()
    inputs[1]!.blur()
  })
  await expect.poll(read).toEqual([
    { ...before[0], line: '第一句已修改' },
    { ...before[1], line: '第二句已修改' },
  ])
})

test('长分镜按内容分区，窄窗口不压缩成竖排且操作可见', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const { dialog } = await openBoard(page)
  const shot = dialog.getByRole('article').first()
  const description = shot.getByLabel('画面', { exact: true })
  const prompt = shot.getByLabel('分镜图提示词', { exact: true })
  const long =
    '雨后清晨，小岚站在湿润的户外木桌旁，低头看着透明水杯，柔和晨光映出水面细微涟漪。'.repeat(8)
  await description.fill(long)
  await description.blur()
  await prompt.fill(long)
  await prompt.blur()
  for (const input of [description, prompt]) {
    expect((await input.boundingBox())!.width).toBeGreaterThan(400)
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(320)
  }
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  await page.setViewportSize({ width: 800, height: 900 })
  await expect.poll(async () => (await description.boundingBox())!.width).toBeGreaterThan(500)
  const content = shot.locator('.storyboard-shot-content')
  expect(
    await content.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
  ).toBe(1)
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await expect(description).toHaveValue(long)
  await expect(prompt).toHaveValue(long)
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  // 点击收起会先提交仍在编辑的草稿；重新展开不丢内容。
  await description.fill('收起前尚未失焦的画面修改')
  await shot.getByRole('button', { name: '收起镜头 1', exact: true }).click()
  await expect(description).toBeHidden()
  await expect(shot.getByLabel('时长')).toBeVisible()
  await shot.getByRole('button', { name: '展开镜头 1', exact: true }).click()
  await expect(description).toHaveValue('收起前尚未失焦的画面修改')
  const total = await dialog.getByRole('article').count()
  await dialog.getByRole('button', { name: '收起全部镜头', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /^展开镜头 \d/ })).toHaveCount(total)
  await dialog.getByRole('button', { name: '展开全部镜头', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /^收起镜头 \d/ })).toHaveCount(total)
  await expect(prompt).toHaveValue(long)
})
