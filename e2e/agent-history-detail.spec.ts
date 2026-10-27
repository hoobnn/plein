import { expect, test } from './fixtures'
import { newProject } from './canvas'

for (const { recovery, initial } of [
  { recovery: '重新读取', initial: false },
  { recovery: '返回原对话', initial: false },
  { recovery: '开始新对话', initial: false },
  { recovery: '重新读取', initial: true },
] as const) {
  test(`${initial ? '自动打开' : '手动切换'}目标历史详情失败后可${recovery}，不误发且保留草稿`, async ({
    page,
  }) => {
    await newProject(page)
    const canvas = new URL(page.url()).hash.split('/').at(-1)!
    const ids: string[] = []
    // 原对话最后创建，列表重读时会优先返回它，重试必须直接读目标详情。
    for (const text of initial ? ['目标讨论'] : ['目标讨论', '原来的讨论']) {
      const response = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
        data: { agent: 'builtin' },
      })
      expect(response.ok()).toBe(true)
      const { id } = (await response.json()) as { id: string }
      ids.push(id)
      await page.request.post(`/api/agent/sessions/${id}/messages`, {
        data: { text, approval: 'auto' },
      })
      await expect
        .poll(
          async () =>
            (
              (await (await page.request.get(`/api/agent/sessions/${id}`)).json()) as {
                status: string
              }
            ).status,
        )
        .toBe('idle')
    }
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    const input = panel.getByPlaceholder('让小满帮你做点什么…')
    const send = panel.getByRole('button', { name: '发送', exact: true })
    let requests = 0
    await page.route(`**/api/agent/sessions/${ids[0]}`, (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      requests++
      if (requests === 1)
        return route.fulfill({
          status: 503,
          json: { error: 'detail_failed', message: '目标详情读取失败' },
        })
      return route.continue()
    })
    const sent: string[] = []
    await page.route('**/api/agent/sessions/*/messages', (route) => {
      sent.push(route.request().url().split('/').at(-2)!)
      return route.fulfill({ status: 204 })
    })
    await page.reload()
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    if (!initial) {
      await expect(panel.getByText('【mock】看过画布了：原来的讨论', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: '历史对话', exact: true }).click()
      await page
        .getByRole('dialog', { name: '历史对话', exact: true })
        .getByRole('button', { name: /^目标讨论/ })
        .click()
    }
    await expect(panel.getByRole('alert')).toContainText('目标详情读取失败')
    if (initial)
      await expect(panel.getByRole('button', { name: '返回原对话', exact: true })).toHaveCount(0)
    await input.fill('要发给所选会话的草稿')
    await expect(send).toBeDisabled()
    await input.press('Enter')
    expect(sent).toEqual([])
    await page.screenshot({
      path: test.info().outputPath('detail-error.png'),
      animations: 'disabled',
    })
    await panel.getByRole('button', { name: recovery, exact: true }).click()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(input).toHaveValue('要发给所选会话的草稿')
    await expect(input).toBeFocused()
    if (recovery === '重新读取') {
      await expect(panel.getByText('【mock】看过画布了：目标讨论', { exact: true })).toBeVisible()
      expect(requests).toBe(2)
    } else if (recovery === '返回原对话') {
      await expect(panel.getByText('【mock】看过画布了：原来的讨论', { exact: true })).toBeVisible()
      expect(requests).toBe(1)
    } else {
      await expect(panel.getByText('【mock】看过画布了：原来的讨论', { exact: true })).toHaveCount(
        0,
      )
    }
    expect(sent).toEqual([])
    await send.click()
    await expect.poll(() => sent.length).toBe(1)
    if (recovery === '重新读取') expect(sent[0]).toBe(ids[0])
    else if (recovery === '返回原对话') expect(sent[0]).toBe(ids[1])
    else expect(ids).not.toContain(sent[0])
    await expect(input).toHaveValue('')
    await expect(panel.getByText('正在发送…', { exact: true })).toHaveCount(0)
    await page.screenshot({
      path: test.info().outputPath('detail-recovered.png'),
      animations: 'disabled',
    })
  })
}
