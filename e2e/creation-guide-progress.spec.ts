import { expect, type Page, test } from '@playwright/test'
import { newProject, waitNode } from './canvas'

const guide = (page: Page) => page.getByTestId('creation-guide')
const stage = (page: Page, id: string) => guide(page).locator(`[data-guide-step="${id}"]`)
const canvasId = (page: Page) => decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
const noRuns = (page: Page) => {
  const requests: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/(?:run|run-flow|run-batch)(?:\?|$)/.test(r.url()))
      requests.push(r.url())
  })
  return requests
}
const close = async (page: Page, name: string) => {
  await page
    .getByRole('dialog', { name, exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await expect(page.getByRole('dialog', { name, exact: true })).toHaveCount(0)
  await expect(page.locator(name === '序列' ? '.seq-editor' : '.storyboard-editor')).toHaveCount(0)
}

async function trial(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '试做选择来源',
      x: 0,
      y: 0,
      params: {
        shots: ['one', 'two'].map((id, i) => ({
          id,
          no: i + 1,
          duration: 2,
          description: `试做画面${i + 1}`,
        })),
      },
    })
    const nodes = ['one', 'two'].flatMap((shot, i) =>
      ['image', 'video'].map((role) =>
        window.__plein.addNode({
          type: `plein/${role}`,
          name: `试做${i + 1}-${role}`,
          x: 500 + i * 500,
          y: role === 'image' ? 0 : 500,
          params: {
            model: `plein/mock:${role}`,
            prompt: '测试试做镜头选择',
            source: { storyboard: board, shot, role },
          },
        }),
      ),
    )
    return { board, nodes }
  })
  for (const id of ids.nodes) {
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvasId(page)}/nodes/${id}/input`)).status(),
      )
      .toBe(200)
    expect(
      (
        await page.request.post(`/api/canvases/${canvasId(page)}/nodes/${id}/run`, { data: {} })
      ).status(),
    ).toBe(202)
    await waitNode(page, id)
  }
  const submissions = noRuns(page)
  const choose = guide(page).getByRole('combobox', { name: '创作引导试做镜头', exact: true })
  await choose.click()
  await page.getByRole('option', { name: '镜头 2 · 试做画面2', exact: true }).click()
  await expect(choose).toContainText('镜头 2')
  return { ...ids, choose, submissions }
}

test('已选试做镜头真实删除后等待重新选择，撤销重做和候选定位均不串镜', async ({ page }) => {
  const f = await trial(page)
  await stage(page, 'storyboard').getByRole('button').click()
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  await editor.getByRole('button', { name: '删除镜头 2', exact: true }).click()
  await page
    .getByRole('dialog', { name: '删除镜头 02？', exact: true })
    .getByRole('button', { name: '删除镜头', exact: true })
    .click()
  await expect(editor.getByRole('article')).toHaveCount(1)
  await close(page, '分镜表')
  await expect(stage(page, 'trial')).toHaveAttribute('data-guide-state', 'attention')
  await expect(stage(page, 'review').getByRole('button')).toBeDisabled()
  await expect(f.choose).toContainText('请选择试做镜头')
  await expect(guide(page)).toContainText('原试做镜头已移除')
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).trialShotId,
      `plein:creation-guide:v1:${canvasId(page)}`,
    ),
  ).toBe('two')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(f.choose).toContainText('镜头 2')
  await expect(stage(page, 'trial')).toHaveAttribute('data-guide-state', 'done')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(stage(page, 'trial')).toHaveAttribute('data-guide-state', 'attention')
  await f.choose.click()
  await page.getByRole('option', { name: '镜头 1 · 试做画面1', exact: true }).click()
  await stage(page, 'review').getByRole('button').click()
  await expect(page.getByRole('dialog', { name: '查看「试做1-image」', exact: true })).toBeVisible()
  await expect(page.locator(`[data-review-node="${f.nodes[0]}"]`)).toBeVisible()
  await page
    .getByRole('dialog', { name: '查看「试做1-image」', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await expect(page.getByRole('dialog', { name: '查看「试做1-image」', exact: true })).toHaveCount(
    0,
  )
  await stage(page, 'storyboard').getByRole('button').click()
  await editor.getByRole('button', { name: '删除镜头 1', exact: true }).click()
  await page
    .getByRole('dialog', { name: '删除镜头 01？', exact: true })
    .getByRole('button', { name: '删除镜头', exact: true })
    .click()
  await close(page, '分镜表')
  await expect(f.choose).toBeDisabled()
  await expect(f.choose).toContainText('请选择试做镜头')
  await expect(stage(page, 'review').getByRole('button')).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 700 })
  await page.getByRole('button', { name: '展开创作引导', exact: true }).click()
  await expect
    .poll(() =>
      guide(page).evaluate((el) => {
        const controls = [
          '[aria-label="收起创作引导"]',
          '[aria-label="创作引导试做镜头"]',
          '[data-guide-step="trial"]',
        ]
        return controls.every((selector) => {
          const rect = el.querySelector(selector)!.getBoundingClientRect()
          return el.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          )
        })
      }),
    )
    .toBe(true)
  await guide(page).screenshot({
    path: test.info().outputPath('guide-missing-trial.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(stage(page, 'trial')).toHaveAttribute('data-guide-state', 'done')
  await expect(stage(page, 'review').getByRole('button')).toBeEnabled()
  expect(f.submissions).toEqual([])
})

test('试做镜头同帧移除时拒绝旧审片入口，恢复计划后继续原镜头', async ({ page }) => {
  const f = await trial(page)
  const original = await stage(page, 'review')
    .getByRole('button')
    .evaluate((button, id) => {
      const map = window.__plein.engine.doc.mutable(id)!.get('params') as {
        get(key: string): unknown
        set(key: string, value: unknown): void
      }
      const shots = map.get('shots') as Array<{ id: string }>
      map.set(
        'shots',
        shots.filter((shot) => shot.id !== 'two'),
      )
      ;(button as HTMLButtonElement).click()
      return shots
    }, f.board)
  await expect(page.getByRole('dialog', { name: /查看「试做/ })).toHaveCount(0)
  await expect(guide(page).getByRole('alert')).toContainText('定位目标已变化')
  await expect(stage(page, 'review').getByRole('button')).toBeDisabled()
  await page.evaluate(
    ({ id, shots }) => {
      ;(
        window.__plein.engine.doc.mutable(id)!.get('params') as {
          set(key: string, value: unknown): void
        }
      ).set('shots', shots)
    },
    { id: f.board, shots: original },
  )
  await expect(f.choose).toContainText('镜头 2')
  await stage(page, 'review').getByRole('button').click()
  await expect(page.getByRole('dialog', { name: '查看「试做2-image」', exact: true })).toBeVisible()
  expect(f.submissions).toEqual([])
})
