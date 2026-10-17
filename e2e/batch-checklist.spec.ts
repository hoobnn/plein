import { expect, test, type Page } from '@playwright/test'
import { clickElement, newProject, waitNode } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const board = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '清单分镜',
      x: 200,
      y: 200,
      params: {
        shots: [1, 2].map((no) => ({
          id: `checklist-${no}`,
          no,
          duration: 2,
          shotSize: '中景',
          description: `画面${no}`,
          characters: [],
          emotion: '',
          lighting: '',
          sfx: '',
          dialogue: [],
          imagePrompt: `清单构图${no}`,
          motionPrompt: '慢慢推进',
        })),
      },
    }),
  )
  const open = async () => {
    await clickElement(page, board)
    await page
      .getByTestId('generator')
      .getByRole('button', { name: /^编辑分镜表/ })
      .click()
    return page.getByRole('dialog', { name: '分镜表', exact: true })
  }
  const initial = await open()
  await initial.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(initial).toBeHidden()
  const images = await page.evaluate(
    (board) =>
      [...window.__plein.engine.doc.elements()]
        .filter((el) => {
          const source = el.params?.source as { storyboard?: string; role?: string } | undefined
          return source?.storyboard === board && source.role === 'image'
        })
        .map((el) => el.id),
    board,
  )
  return { board, images, open }
}

test('批量先预检零提交，内容改变需重查，确认期间关闭不会丢失清单', async ({ page }) => {
  const f = await fixture(page)
  let submissions = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/storyboard-batch/commit'))
      submissions++
  })
  const board = await f.open()
  await board.getByRole('button', { name: '批量出分镜图', exact: true }).click()
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  await expect(checklist.getByLabel('清单汇总')).toContainText('生成 2 项')
  const confirm = checklist.getByRole('button', { name: '确认并开始生成', exact: true })
  await expect(confirm).toBeEnabled()
  expect(submissions).toBe(0)
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: string): void
    }
    params.set('prompt', '清单打开后改成逆光构图')
  }, f.images[0]!)
  await expect(confirm).toBeDisabled()
  await expect(checklist).toContainText('内容或任务已变化')
  await checklist.getByRole('button', { name: '重新检查清单', exact: true }).click()
  await expect(confirm).toBeEnabled()
  await checklist.locator('details').first().locator('summary').click()
  await expect(checklist).toContainText('逆光构图')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/storyboard-batch/commit', async (route) => {
    await gate
    await route.continue()
  })
  await confirm.click()
  await expect(checklist.getByRole('button', { name: '正在确认…', exact: true })).toBeDisabled()
  await checklist.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(checklist).toBeVisible()
  release()
  await expect(checklist).toBeHidden()
  for (const id of f.images) await waitNode(page, id)
  expect(submissions).toBe(1)
})

test('未就绪视频列为阻塞，可从清单定位，零生成提交', async ({ page }) => {
  const f = await fixture(page)
  let submits = 0
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(?:run|run-batch|commit)$/.test(new URL(request.url()).pathname)
    )
      submits++
  })
  const board = await f.open()
  await board.getByRole('button', { name: '批量生成视频', exact: true }).click()
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  await expect(checklist.getByLabel('清单汇总')).toContainText('阻塞 2 项')
  await expect(
    checklist.getByRole('button', { name: '确认并开始生成', exact: true }),
  ).toBeDisabled()
  await checklist.getByRole('button', { name: '定位', exact: true }).first().click()
  await expect(checklist).toBeHidden()
  await expect(board).toBeHidden()
  await expect(page.getByTestId('generator')).toBeVisible()
  expect(submits).toBe(0)
})

test('删除唯一已选镜头后清除失效选区，清单对应剩余镜头', async ({ page }) => {
  const f = await fixture(page)
  const board = await f.open()
  await board.getByRole('checkbox', { name: '选择镜头 1', exact: true }).check()
  await board.getByRole('button', { name: '删除镜头 1', exact: true }).click()
  await page.getByRole('button', { name: '删除镜头', exact: true }).click()
  await expect(board.getByRole('article')).toHaveCount(1)
  await expect(board.getByRole('toolbar', { name: '分镜批量操作' })).toContainText('作用于全部镜头')
  await expect(board.getByRole('checkbox', { name: '全选', exact: true })).not.toBeChecked()
  await board.getByRole('button', { name: '批量出分镜图', exact: true }).click()
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  await expect(checklist.getByLabel('清单汇总')).toContainText('生成 1 项')
  await expect(checklist.getByRole('table')).toContainText('镜头 2')
  const confirm = checklist.getByRole('button', { name: '确认并开始生成', exact: true })
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await waitNode(page, f.images[1]!)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results ?? [], f.images[0]!),
  ).toHaveLength(0)
})

test('协作删除部分已选镜头后，全选和批量范围只计现存镜头', async ({ page }) => {
  const f = await fixture(page)
  const board = await f.open()
  await board.getByRole('checkbox', { name: '全选', exact: true }).check()
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      get(key: string): unknown[]
      set(key: string, value: unknown): void
    }
    params.set('shots', params.get('shots').slice(1))
  }, f.board)
  await expect(board.getByRole('toolbar', { name: '分镜批量操作' })).toContainText(
    '选中的 1 个镜头',
  )
  await expect(board.getByText('已选择 1 / 1 个镜头', { exact: true })).toBeVisible()
  await expect(board.getByRole('checkbox', { name: '全选', exact: true })).toBeChecked()
  await board.getByRole('button', { name: '批量出分镜图', exact: true }).click()
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  await expect(checklist.getByLabel('清单汇总')).toContainText('生成 1 项')
  await expect(checklist.getByRole('table')).toContainText('镜头 2')
})
