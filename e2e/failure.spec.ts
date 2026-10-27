import { expect, test } from './fixtures'
import { addNode, elements, newProject, revealGenerator, waitNode } from './canvas'

const MOCK = '/api/providers/plein/mock/config'

test.afterEach(async ({ request }) => {
  await request.put(MOCK, { data: { settings: { failWith: 'none' } } })
})

test(
  '平台报错时节点上给出可读的失败原因，改好后能重试成功',
  { tag: '@core' },
  async ({ page, request }) => {
    expect((await request.put(MOCK, { data: { settings: { failWith: 'auth' } } })).ok()).toBe(true)

    await newProject(page)
    await addNode(page, '生成图片')
    await expect
      .poll(async () => (await elements(page)).filter((e) => e.kind === 'node'))
      .toHaveLength(1)
    const [node] = (await elements(page)).filter((e) => e.kind === 'node')
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
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
    // 密钥问题给“去设置”，直接打开模型平台设置
    await failed.getByRole('button', { name: '打开模型平台设置' }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings.getByText('火山方舟').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    await request.put(MOCK, { data: { settings: { failWith: 'none' } } })
    await run()
    await waitNode(page, node!.id, 30_000)
    await expect(failed).toBeHidden()
  },
)
