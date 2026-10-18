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

for (const role of ['speech', 'sfx'] as const) {
  test(`${role} 只按对应成片端口关联，实际清空文本后不把历史序列当当前交付`, async ({ page }) => {
    await newProject(page)
    const submissions = noRuns(page)
    const ids = await page.evaluate((role) => {
      const board = window.__plein.addNode({
        type: 'plein/storyboard',
        name: '声音关联来源',
        x: 0,
        y: 0,
        params: {
          shots: [
            {
              id: 'one',
              no: 1,
              duration: 2,
              description: '声音连线测试',
              dialogue:
                role === 'speech' ? [{ id: 'line', character: '甲', line: '保留的声音文本' }] : [],
              sfx: role === 'sfx' ? '保留的声音文本' : '',
            },
          ],
        },
      })
      const sound = window.__plein.addNode({
        type: `plein/${role}`,
        name: '镜头声音',
        x: 500,
        y: 0,
        params: {
          text: '保留的声音文本',
          source: { storyboard: board, shot: 'one', role, dialogueId: 'line', line: 0 },
        },
      })
      const films = ['正确关联成片', '仅用作配乐的序列'].map((name, i) =>
        window.__plein.addNode({
          type: 'plein/sequence',
          name,
          x: 1000 + i * 500,
          y: 0,
          params: {},
        }),
      )
      if (
        !window.__plein.connect(
          [sound, 'audio'],
          [films[0]!, role === 'speech' ? 'dialogue' : 'sfx'],
        ) ||
        !window.__plein.connect([sound, 'audio'], [films[1]!, 'music'])
      )
        throw new Error('fixture links failed')
      return { board, sound, films }
    }, role)
    await expect(stage(page, 'delivery').getByRole('button')).toBeEnabled()
    await expect(
      guide(page).getByRole('combobox', { name: '创作引导交付序列', exact: true }),
    ).toHaveCount(0)
    await stage(page, 'delivery').getByRole('button').click()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
      ids.films[0],
    ])
    await close(page, '序列')
    await page.evaluate((id) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        deleteSelection(): void
        doc: { undo: { stopCapturing(): void } }
      }
      engine.doc.undo.stopCapturing()
      engine.selection.set([id])
      engine.deleteSelection()
      engine.doc.undo.stopCapturing()
    }, ids.films[1]!)
    await stage(page, 'storyboard').getByRole('button').click()
    const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
    const field = editor.getByLabel(role === 'speech' ? '台词' : '音效', { exact: true })
    await field.fill('')
    await field.blur()
    await expect
      .poll(() =>
        page.evaluate(
          ({ id, role }) => {
            const shots = window.__plein.engine.doc.get(id)!.params!.shots as Array<{
              sfx: string
              dialogue: Array<{ line: string }>
            }>
            return role === 'speech' ? (shots[0]!.dialogue[0]?.line ?? '') : shots[0]!.sfx
          },
          { id: ids.board, role },
        ),
      )
      .toBe('')
    await close(page, '分镜表')
    await stage(page, 'delivery').getByRole('button').click()
    await expect(page.getByRole('dialog', { name: '序列', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toBeVisible()
    await close(page, '分镜表')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await stage(page, 'delivery').getByRole('button').click()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
      ids.films[0],
    ])
    expect(submissions).toEqual([])
  })
}

test('未展开模板可打开唯一序列，展开后无有效连线不继续当作交付目标', async ({ page }) => {
  await newProject(page)
  const submissions = noRuns(page)
  const ids = await page.evaluate(() => {
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '唯一空序列的模板',
      x: 0,
      y: 0,
      params: { shots: [{ id: 'one', no: 1, duration: 2 }] },
    })
    const film = window.__plein.addNode({
      type: 'plein/sequence',
      name: '模板空序列',
      x: 500,
      y: 0,
      params: {},
    })
    return { board, film }
  })
  await stage(page, 'delivery').getByRole('button').click()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids.film])
  await close(page, '序列')
  await page.evaluate(
    (board) =>
      window.__plein.addNode({
        type: 'plein/video',
        name: '尚未连接的镜头',
        x: 500,
        y: 500,
        params: { source: { storyboard: board, shot: 'one', role: 'video' } },
      }),
    ids.board,
  )
  await stage(page, 'delivery').getByRole('button').click()
  await expect(page.getByRole('dialog', { name: '序列', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toBeVisible()
  expect(submissions).toEqual([])
})

test('另一分镜删除后，其残留素材连接的唯一序列不回退给当前分镜', async ({ page }) => {
  await newProject(page)
  const submissions = noRuns(page)
  const ids = await page.evaluate(() => {
    const add = window.__plein.addNode
    const current = add({
      type: 'plein/storyboard',
      name: '当前空白分镜',
      x: 0,
      y: 0,
      params: { shots: [{ id: 'one', no: 1, duration: 2 }] },
    })
    const old = add({
      type: 'plein/storyboard',
      name: '即将移除的旧分镜',
      x: 500,
      y: 0,
      params: { shots: [{ id: 'old', no: 1, duration: 2 }] },
    })
    const video = add({
      type: 'plein/video',
      name: '保留的旧镜头',
      x: 1000,
      y: 0,
      params: { source: { storyboard: old, shot: 'old', role: 'video' } },
    })
    const film = add({ type: 'plein/sequence', name: '旧创作线成片', x: 1500, y: 0, params: {} })
    if (!window.__plein.connect([video, 'video'], [film, 'clips']))
      throw new Error('fixture link failed')
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      deleteSelection(): void
    }
    engine.selection.set([old])
    engine.deleteSelection()
    return { current, film }
  })
  await expect(guide(page)).toContainText('当前空白分镜')
  await stage(page, 'delivery').getByRole('button').click()
  await expect(page.getByRole('dialog', { name: '序列', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids.current])
  await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toBeVisible()
  expect(submissions).toEqual([])
})
