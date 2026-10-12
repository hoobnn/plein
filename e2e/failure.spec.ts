import { expect, test } from '@playwright/test'
import { elements, waitEngine } from './canvas'

const MOCK = '/api/providers/plein/mock/config'

test.afterEach(async ({ request }) => {
  await request.put(MOCK, { data: { settings: { failWith: 'none' } } })
})

test('平台报错时节点上给出可读的失败原因，改好后能重试成功', async ({ page, request }) => {
  expect((await request.put(MOCK, { data: { settings: { failWith: 'auth' } } })).ok()).toBe(true)

  await page.goto('/')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await waitEngine(page)
  await page.mouse.dblclick(720, 450)
  await page.getByPlaceholder('添加节点').fill('生成图片')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'node'))
    .toHaveLength(1)
  const [node] = (await elements(page)).filter((e) => e.kind === 'node')
  const generator = page.getByTestId('generator')
  await generator.locator('textarea').first().fill('雨夜天台上的铁盒')
  const run = () => generator.getByRole('button', { name: /生成$/ }).click()

  await run()
  const failed = page.locator('.plein-node-failed')
  await expect(failed).toBeVisible({ timeout: 30_000 })
  const reason = await failed.innerText()
  test.info().annotations.push({ type: '失败提示', description: reason })
  // 说人话：带中文说明，不是裸的错误码或堆栈
  expect(reason).toMatch(/[一-龥]/)
  expect(reason).not.toMatch(/Error:|at \w+ \(/)

  await request.put(MOCK, { data: { settings: { failWith: 'none' } } })
  await run()
  await expect
    .poll(async () => (await elements(page)).find((e) => e.id === node!.id)?.status, {
      timeout: 30_000,
    })
    .toBe('succeeded')
  await expect(failed).toBeHidden()
})
