import { expect, test } from './fixtures'
import { centerOf, elements, newProject, settle, waitEngine } from './canvas'
import { slowFile } from './slow-file'

test('多目标历史部分删除时只定位剩余元素，全删后撤下入口，撤销逐步恢复', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const ids = await page.evaluate(() =>
    ['目标甲', '目标乙', '无关元素'].map((name, i) =>
      window.__plein.addNode({ type: 'plein/text', name, params: {}, x: i * 4000, y: i * 700 }),
    ),
  )
  await settle(page, ids[0]!)
  const response = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  expect(response.ok()).toBe(true)
  const session = (await response.json()) as { id: string; items: unknown[] }
  const targets = [ids[0], ids[1], ids[0], 'el-unavailable-fixture']
  session.items = [
    {
      id: 'approval-fixture',
      type: 'approval',
      tool: 'delete_elements',
      reason: '历史记录中的两个目标',
      ids: targets,
      status: 'expired',
      at: Date.now(),
    },
    {
      id: 'changes-fixture',
      type: 'changes',
      turn: 'turn-fixture',
      created: targets,
      updated: [ids[1]],
      deleted: [],
      edges: 0,
      runs: 0,
      undoable: false,
      at: Date.now(),
    },
  ]
  await page.route(`**/api/agent/sessions/${session.id}`, (route) =>
    route.fulfill({ json: session }),
  )
  await page.route(`**/api/agent/sessions/${session.id}/events`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'session', session })}\n\n`,
    }),
  )
  await page.reload()
  await waitEngine(page)
  await expect.poll(async () => (await elements(page)).length).toBe(3)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const approval = panel
    .locator('.plein-agent-approval')
    .getByRole('button', { name: '在画布上查看', exact: true })
  const changes = panel.getByRole('button', { name: '在画布上查看改动', exact: true })
  const selection = () => page.evaluate(() => window.__plein.engine.selection.values())
  const remove = async (id: string) => {
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), id)
    await page
      .locator('canvas')
      .first()
      .evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await elements(page)).some((e) => e.id === id)).toBe(false)
  }
  await changes.click()
  expect((await selection()).sort()).toEqual([ids[0]!, ids[1]!].sort())
  await settle(page, ids[0]!)
  await remove(ids[0]!)
  await expect(changes).toBeVisible()
  await expect(approval).toBeVisible()
  await changes.click()
  expect(await selection()).toEqual([ids[1]])
  await settle(page, ids[1]!)
  await page.evaluate(() =>
    (
      window.__plein.engine as unknown as { camera: { panBy(x: number, y: number): void } }
    ).camera.panBy(-2500, 0),
  )
  await approval.click()
  await settle(page, ids[1]!)
  const point = await centerOf(page, ids[1]!)
  expect(point.x).toBeGreaterThan(296)
  expect(point.x).toBeLessThan(1016)
  expect(await selection()).toEqual([ids[1]])
  await page.screenshot({
    path: test.info().outputPath('partial-targets.png'),
    animations: 'disabled',
  })
  await remove(ids[1]!)
  await expect(approval).toHaveCount(0)
  await expect(changes).toHaveCount(0)
  expect((await elements(page)).map((e) => e.id)).toEqual([ids[2]])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await elements(page)).some((e) => e.id === ids[1])).toBe(true)
  await expect(changes).toBeVisible()
  await expect(approval).toBeVisible()
  await changes.click()
  expect(await selection()).toEqual([ids[1]])
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await elements(page)).length).toBe(3)
  await changes.click()
  expect((await selection()).sort()).toEqual([ids[0]!, ids[1]!].sort())
})

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
