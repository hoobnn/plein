import { DatabaseSync } from 'node:sqlite'
import { expect, type Locator, type Page } from '@playwright/test'
import type { GroupRunStarted, GroupRunState } from '../../packages/protocol/src/runs'
import type { StoryboardBatchPlan } from '../../packages/protocol/src/storyboard-batch'
import { clickStoryboardAction } from '../canvas'

/** 查询整块画布的未核实提交，包括已经滚出最近 100 条任务的记录。 */
export function checkReleaseSubmissions(file: string, canvas: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const unknown = db
      .prepare(`
      SELECT id FROM jobs
      WHERE canvas_id = ? AND status IN ('failed', 'canceled')
        AND COALESCE(json_extract(recovery, '$.dismissed'), 0) = 0
        AND (json_extract(recovery, '$.state') = 'submit_unknown' OR EXISTS (
          SELECT 1 FROM json_each(calls)
          WHERE json_extract(value, '$.state') IN ('unknown', 'submitting')
        ))
    `)
      .all(canvas)
    if (unknown.length)
      throw new Error(
        `submit_unknown：${unknown.map((row) => row.id).join('、')}。请在任务面板和平台核对远端任务 ID，找到 ID 后关联原任务续查。验收已停止，未重新提交。`,
      )
  } finally {
    db.close()
  }
}

/** 只补齐缺项。提交响应丢失时直接中止，重开清单可能产生第二次付费提交。 */
export async function startReleaseBatch(
  dialog: Locator,
  boardId: string,
  role: 'image' | 'video' | 'speech',
  checkSubmissions: () => void,
): Promise<GroupRunStarted | null> {
  const page = dialog.page()
  const canvas = decodeURIComponent(new URL(page.url()).hash.split('/')[2]!)
  const batchUrl = new URL(
    `/api/canvases/${encodeURIComponent(canvas)}/nodes/${encodeURIComponent(boardId)}/storyboard-batch/`,
    page.url(),
  )
  const labels = { image: '批量出分镜图', video: '批量生成视频', speech: '批量配音' }
  checkSubmissions()
  const [preview] = await Promise.all([
    page.waitForResponse(new URL('preview', batchUrl).href),
    clickStoryboardAction(dialog, labels[role]),
  ])
  expect(preview.status(), await preview.text()).toBe(200)
  const plan: StoryboardBatchPlan = await preview.json()
  expect(plan).toMatchObject({
    sourceId: boardId,
    scope: { canvasId: canvas, boardId },
    request: { role, reuseExisting: true },
  })
  expect(plan.rows.filter((row) => row.action === 'blocked').map((row) => row.name)).toEqual([])
  if (plan.request.role === 'video')
    expect(
      plan.rows.filter((row) => row.prerequisite && row.action === 'run'),
      '镜头图已在上一步完成',
    ).toEqual([])
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  if (!plan.summary.run) {
    await checklist.getByRole('button', { name: '取消', exact: true }).click()
    return null
  }
  const confirm = checklist.getByRole('button', { name: '确认并开始生成', exact: true })
  await expect(confirm).toBeEnabled()
  checkSubmissions()
  const [request] = await Promise.all([
    page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url() === new URL('commit', batchUrl).href &&
        req.postDataJSON().token === plan.token,
    ),
    confirm.click(),
  ])
  const response = await request.response()
  if (!response || response.status() >= 500)
    throw new Error(
      '批量确认结果未知，请先在任务面板核对原批次及远端任务 ID。验收已停止，未重新提交。',
    )
  expect(response.status(), await response.text()).toBe(202)
  const started: GroupRunStarted = await response.json()
  expect(started.total).toBe(plan.summary.run)
  await expect(checklist).toBeHidden()
  return started
}

export async function waitReleaseGroup(
  page: Page,
  groupId: string,
  checkSubmissions: () => void,
  timeout: number,
) {
  await expect
    .poll(
      async () => {
        checkSubmissions()
        const response = await page.request.get(`/api/runs/groups/${encodeURIComponent(groupId)}`)
        expect(response.status()).toBe(200)
        const state: GroupRunState = await response.json()
        if (state.status === 'canceled') throw new Error(`验收批次 ${groupId} 已取消`)
        return state.status
      },
      { timeout, intervals: [250, 1_000, 2_000] },
    )
    .toBe('done')
  checkSubmissions()
}
