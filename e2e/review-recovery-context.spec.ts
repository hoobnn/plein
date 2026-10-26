import { expect, type Page, test } from '@playwright/test'
import type { JobInfo } from '../packages/protocol/src/runs'
import { clickElement, newProject, openStoryboardActions } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  const board = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '原任务隔离分镜',
      x: 400,
      y: 200,
      params: {
        shots: [
          {
            id: 'context-shot',
            no: 1,
            duration: 2,
            shotSize: '中景',
            description: '保持这个镜头',
            characters: [],
            emotion: '',
            lighting: '',
            sfx: '',
            dialogue: [],
            imagePrompt: '玻璃杯',
            motionPrompt: '缓慢推进',
          },
        ],
      },
    }),
  )
  const open = async () => {
    await clickElement(page, board)
    await page
      .getByTestId('generator')
      .getByRole('button', { name: /^编辑分镜表/ })
      .click()
    const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
    await openStoryboardActions(dialog)
    return dialog
  }
  let dialog = await open()
  await dialog.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(dialog).toBeHidden()
  const image = await page.evaluate(
    (board) =>
      [...window.__plein.engine.doc.elements()].find((el) => {
        const source = el.params?.source as { storyboard?: string; role?: string } | undefined
        return source?.storyboard === board && source.role === 'image'
      })!.id,
    board,
  )
  const old: JobInfo = {
    id: 'context-old',
    nodeId: image,
    nodeType: 'plein/image',
    status: 'failed',
    attempts: 1,
    createdAt: Date.now(),
    recovery: { state: 'submit_unknown', provider: '旧平台', attachable: true },
  }
  let job = old
  const calls: Array<{ job: string; body: unknown }> = []
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let hold = false
  let fail = false
  let reads = 0
  let submissions = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url())) submissions++
  })
  await page.route('**/api/canvases/*/jobs/latest', (route) => {
    reads++
    return route.fulfill({ json: { jobs: [job] } })
  })
  await page.route('**/api/canvases/*/jobs/context-*/recover', async (route) => {
    const id = /\/jobs\/([^/]+)\/recover/.exec(route.request().url())![1]!
    calls.push({ job: id, body: route.request().postDataJSON() })
    if (fail) {
      fail = false
      return route.fulfill({ status: 503, json: { message: '旧任务恢复暂时失败' } })
    }
    const receipt = id === old.id ? old : job
    if (hold) await pending
    await route.fulfill({ json: receipt })
  })
  dialog = await open()
  await dialog.getByRole('button', { name: '审核镜头', exact: true }).click()
  const row = dialog
    .getByRole('table', { name: '逐镜审核', exact: true })
    .locator('[data-shot-id="context-shot"]')
  await expect(row.getByTestId('job-recovery')).toContainText('旧平台')
  return {
    row,
    calls,
    release,
    reads: () => reads,
    fail: () => {
      fail = true
    },
    hold: () => {
      hold = true
    },
    submissions: () => submissions,
    next: async () => {
      job = {
        ...old,
        id: 'context-new',
        createdAt: Date.now() + 1,
        recovery: { ...old.recovery!, provider: '新平台' },
      }
      await expect(row.getByTestId('job-recovery')).toContainText('新平台')
    },
  }
}

for (const draft of ['attach', 'confirm', 'error'] as const) {
  test(`最新原任务变化时清除旧 ${draft} 草稿，恢复请求只发送到新任务`, async ({ page }) => {
    const f = await setup(page)
    const input = f.row.getByRole('textbox', { name: '平台任务 ID', exact: true })
    if (draft !== 'confirm') {
      await f.row.getByRole('button', { name: '填写平台任务 ID', exact: true }).click()
      await input.fill('old-remote-id')
      if (draft === 'error') {
        f.fail()
        await f.row.getByRole('button', { name: '接着取结果', exact: true }).click()
        await expect(f.row.getByRole('alert')).toHaveText('旧任务恢复暂时失败')
      }
    } else await f.row.getByRole('button', { name: '确认未受理，重新提交', exact: true }).click()
    await f.next()
    await expect(input).toHaveCount(0)
    await expect(f.row.getByRole('alert')).toHaveCount(0)
    await expect(f.row.getByRole('button', { name: '重新提交', exact: true })).toHaveCount(0)
    await f.row.getByRole('button', { name: '填写平台任务 ID', exact: true }).click()
    await input.fill('new-remote-id')
    if (draft === 'attach')
      await page.screenshot({ path: 'test-results/review-recovery-new-job.png' })
    await f.row.getByRole('button', { name: '接着取结果', exact: true }).click()
    const previous =
      draft === 'error'
        ? [{ job: 'context-old', body: { action: 'attach', remoteId: 'old-remote-id' } }]
        : []
    await expect
      .poll(() => f.calls)
      .toEqual([
        ...previous,
        { job: 'context-new', body: { action: 'attach', remoteId: 'new-remote-id' } },
      ])
    expect(f.submissions()).toBe(0)
  })
}

test('旧任务恢复迟到返回，不清空新任务正在输入的 ID', async ({ page }) => {
  const f = await setup(page)
  const input = f.row.getByRole('textbox', { name: '平台任务 ID', exact: true })
  f.hold()
  let completed: Promise<unknown> | undefined
  let readsBefore = 0
  try {
    await f.row.getByRole('button', { name: '填写平台任务 ID', exact: true }).click()
    await input.fill('old-pending-id')
    await f.row.getByRole('button', { name: '接着取结果', exact: true }).click()
    await expect.poll(() => f.calls.length).toBe(1)
    completed = page
      .waitForResponse((response) => response.url().endsWith('/jobs/context-old/recover'))
      .then((response) => response.finished())
    await f.next()
    await expect(input).toHaveCount(0)
    await f.row.getByRole('button', { name: '填写平台任务 ID', exact: true }).click()
    await input.fill('new-unsent-draft')
    readsBefore = f.reads()
  } finally {
    f.release()
  }
  await completed
  await expect.poll(() => f.reads()).toBeGreaterThan(readsBefore)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(f.row.getByRole('button', { name: '接着取结果', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('new-unsent-draft')
  expect(f.calls).toEqual([
    { job: 'context-old', body: { action: 'attach', remoteId: 'old-pending-id' } },
  ])
  expect(f.submissions()).toBe(0)
})
