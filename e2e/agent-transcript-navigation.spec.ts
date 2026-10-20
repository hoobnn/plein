import { expect, test } from '@playwright/test'
import { elements, newProject } from './canvas'

test('长会话可按区域阅读和键盘翻页，方案可访问且不穿透修改画布', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  expect(created.ok()).toBe(true)
  const { id } = (await created.json()) as { id: string }
  const send = async (text: string, wait = true) => {
    const response = await page.request.post(`/api/agent/sessions/${id}/messages`, {
      data: { text, approval: 'rules' },
    })
    expect(response.ok()).toBe(true)
    if (wait)
      await expect
        .poll(
          async () => (await (await page.request.get(`/api/agent/sessions/${id}`)).json()).status,
        )
        .toBe('idle')
  }
  for (let i = 0; i < 8; i++)
    await send(`历史讨论 ${i}：${'先核对镜头和角色，再讨论节奏与画面。'.repeat(10)}`)
  await send('画一张雨夜天台')
  await send('让画面更紧张', false)
  await page.reload()
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const transcript = panel.getByRole('region', { name: '对话记录', exact: true })
  await expect(transcript).toBeVisible()
  const card = transcript.getByRole('group', { name: /^修改方案：/ })
  const approve = card.getByRole('button', { name: '只改文字', exact: true })
  await expect(approve).toBeEnabled()
  const snapshot = await transcript.ariaSnapshot()
  expect(snapshot).toContain('历史讨论 0')
  expect(snapshot).toContain('只改文字')
  await transcript.focus()
  const bottom = await transcript.evaluate((el) => el.scrollTop)
  expect(bottom).toBeGreaterThan(500)
  await transcript.press('PageUp')
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeLessThan(bottom - 100)
  const before = await elements(page)
  await page.evaluate(
    (ids) => window.__plein.engine.selection.set(ids),
    before.map((el) => el.id),
  )
  await transcript.press('Delete')
  await transcript.press('ArrowDown')
  expect(await elements(page)).toEqual(before)
  await transcript.press('End')
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(2)
  await approve.click()
  await expect(card).toHaveAttribute('data-status', 'applied')
  await expect(transcript.getByText('【mock】方案已经按你选的范围执行。')).toBeVisible()
  await transcript.screenshot({ path: test.info().outputPath('long-transcript.png') })
})
