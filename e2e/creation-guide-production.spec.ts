import { expect, type Page, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

const guide = (page: Page) => page.getByTestId('creation-guide')
const state = (page: Page) => guide(page).locator('[data-guide-step="storyboard"]')
async function seed(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '生产记录测试',
      x: 100,
      y: 100,
      params: {
        shots: ['one', 'two'].map((id, index) => ({
          id,
          no: index + 1,
          duration: 2,
          description: `画面${index + 1}`,
        })),
      },
    }),
  )
  await expect(guide(page)).toBeVisible()
  return id
}
const inspect = (page: Page, id: string) =>
  page.evaluate((id) => window.__plein.engine.doc.get(id)!.production, id)
const watch = (page: Page) => {
  const submitted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/run(?:-|\?|$)/.test(request.url()))
      submitted.push(request.url())
  })
  return submitted
}

test('内容核对和代表镜头选择跨客户端持久化，真实UI操作人明确，旧本机标记无效', async ({
  page,
  browser,
}, testInfo) => {
  const id = await seed(page)
  const submitted = watch(page)
  await page.evaluate(() =>
    localStorage.setItem(
      `plein:creation-guide:v1:${decodeURIComponent(location.hash.split('/c/')[1]!.split('?')[0]!)}`,
      JSON.stringify({ reviewedPlans: { ignored: 'any' }, trialShotId: 'one' }),
    ),
  )
  await page.reload()
  await waitEngine(page)
  await expect(state(page)).toHaveAttribute('data-guide-state', 'ready')
  await guide(page).getByRole('combobox', { name: '创作引导试做镜头' }).click()
  await page.getByRole('option', { name: '镜头 2 · 画面2', exact: true }).click()
  await guide(page).getByRole('button', { name: '我已人工核对这份分镜', exact: true }).click()
  await expect(state(page)).toHaveAttribute('data-guide-state', 'done')
  const data = (await inspect(page, id))!
  expect(data.selection?.trialShotId).toBe('two')
  const principal = await (await page.request.get('/api/session')).json()
  expect(data.confirmations[0]!.actor).toEqual({ userId: principal.principal.id, source: 'ui' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const peer = await context.newPage()
    const peerSubmits = watch(peer)
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(state(peer)).toHaveAttribute('data-guide-state', 'done')
    await expect(guide(peer).getByRole('combobox', { name: '创作引导试做镜头' })).toContainText(
      '镜头 2',
    )
    await page.reload()
    await waitEngine(page)
    await expect(state(page)).toHaveAttribute('data-guide-state', 'done')
    await guide(page).getByText('分镜核对历史（1）', { exact: true }).click()
    await expect(guide(page).getByRole('list', { name: '分镜核对历史' })).toContainText(
      '当前内容已核对',
    )
    await guide(page).screenshot({
      path: testInfo.outputPath('production-confirmation-history.png'),
    })
    expect(peerSubmits).toEqual([])
  } finally {
    await context.close()
  }
  expect(submitted).toEqual([])
})

test('制作决策追加新修订，撤销重做保留原记录，刷新后历史可核对且零生成', async ({
  page,
}, testInfo) => {
  const id = await seed(page)
  const submitted = watch(page)
  await guide(page).getByText('制作决策（0）', { exact: true }).click()
  await guide(page).getByRole('textbox', { name: '本次选择', exact: true }).fill('黑白纪实')
  await guide(page).getByRole('textbox', { name: '修订理由', exact: true }).fill('先试人物辨识度')
  await guide(page).getByRole('button', { name: '保存为新修订', exact: true }).click()
  const first = (await inspect(page, id))!.decisions[0]!
  await guide(page).getByRole('textbox', { name: '本次选择', exact: true }).fill('暖色纪实')
  await guide(page).getByRole('button', { name: '保存为新修订', exact: true }).click()
  await expect(guide(page).getByRole('list', { name: '制作决策历史' })).toContainText('旧修订')
  await expect(guide(page).getByRole('list', { name: '制作决策历史' })).toContainText(
    '暖色纪实 · 当前选择',
  )
  expect((await inspect(page, id))!.decisions[0]).toEqual(first)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await inspect(page, id))!.decisions.length).toBe(1)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(async () => (await inspect(page, id))!.decisions.length).toBe(2)
  await page.reload()
  await waitEngine(page)
  await guide(page).getByText('制作决策（2）', { exact: true }).click()
  await expect(guide(page).getByRole('list', { name: '制作决策历史' })).toContainText('黑白纪实')
  await guide(page).screenshot({ path: testInfo.outputPath('production-decision-revisions.png') })
  expect(submitted).toEqual([])
})

test('实时升级只读后不能确认、修改代表镜头或追加决策，仍可查看历史', async ({ page }, testInfo) => {
  const id = await seed(page)
  const submitted = watch(page)
  await page.evaluate(() => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      schemaVersion: number
      meta: { set(key: string, value: unknown): void }
    }
    doc.meta.set('schemaVersion', doc.schemaVersion + 1)
  })
  await expect(
    guide(page).getByRole('button', { name: '我已人工核对这份分镜', exact: true }),
  ).toBeDisabled()
  await expect(guide(page).getByRole('combobox', { name: '创作引导试做镜头' })).toBeDisabled()
  await guide(page).getByText('制作决策（0）', { exact: true }).click()
  await expect(
    guide(page).getByRole('button', { name: '保存为新修订', exact: true }),
  ).toBeDisabled()
  await expect(guide(page).getByRole('textbox', { name: '本次选择', exact: true })).toBeDisabled()
  expect((await inspect(page, id))!.confirmations).toEqual([])
  expect((await inspect(page, id))!.decisions).toEqual([])
  await guide(page).screenshot({ path: testInfo.outputPath('production-readonly.png') })
  expect(submitted).toEqual([])
})
