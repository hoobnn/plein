import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const guide = (page: Page) => page.getByTestId('creation-guide')
const step = (page: Page, id: string) =>
  guide(page).locator(`[data-guide-step="${id}"]`).getByRole('button')
const canvasId = (page: Page) => decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)

async function fixture(page: Page, boards = 1, sequences = 1, sameNames = false) {
  await newProject(page)
  const submitted: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/(?:run|run-flow|run-batch)(?:\?|$)/.test(r.url()))
      submitted.push(r.url())
  })
  const ids = await page.evaluate(
    ({ boards, sequences, sameNames }) => {
      const boardIds = Array.from({ length: boards }, (_, i) =>
        window.__plein.addNode({
          type: 'plein/storyboard',
          name: sameNames ? '同名分镜' : `引导分镜${i + 1}`,
          x: i * 500,
          y: 100,
          params: { shots: [{ id: 'one', no: 1, duration: 2, description: `分镜${i + 1}的画面` }] },
        }),
      )
      const board = boardIds.at(-1)!
      const video = window.__plein.addNode({
        type: 'plein/video',
        name: '引导视频',
        x: 600,
        y: 500,
        params: { source: { storyboard: board, shot: 'one', role: 'video' } },
      })
      const films = Array.from({ length: sequences }, (_, i) => {
        const id = window.__plein.addNode({
          type: 'plein/sequence',
          name: sameNames ? '同名成片' : `引导成片${i + 1}`,
          x: 1100 + i * 500,
          y: 500,
          params: { aspectRatio: i ? '9:16' : '16:9' },
        })
        if (!window.__plein.connect([video, 'video'], [id, 'clips']))
          throw new Error('fixture link failed')
        return id
      })
      return { boards: boardIds, board, video, films }
    },
    { boards, sequences, sameNames },
  )
  await expect(guide(page)).toBeVisible()
  return { ...ids, submitted }
}

async function remove(page: Page, id: string) {
  await page.evaluate((id) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      deleteSelection(): void
      doc: { undo: { stopCapturing(): void } }
    }
    engine.doc.undo.stopCapturing()
    engine.selection.set([id])
    engine.deleteSelection()
    engine.doc.undo.stopCapturing()
  }, id)
}

for (const kind of ['board', 'sequence'] as const) {
  test(`收起重开后改选${kind === 'board' ? '分镜' : '成片'}再删除，不恢复打开时的旧选择`, async ({
    page,
  }) => {
    const f = await fixture(page, kind === 'board' ? 2 : 1, kind === 'sequence' ? 2 : 1)
    const name = kind === 'board' ? '创作引导分镜' : '创作引导交付序列'
    const label = kind === 'board' ? '引导分镜' : '引导成片'
    const ids = kind === 'board' ? f.boards : f.films
    const choose = guide(page).getByRole('combobox', { name, exact: true })
    await choose.click()
    await page.getByRole('option', { name: `${label}1`, exact: true }).click()
    await guide(page).getByRole('button', { name: '收起创作引导', exact: true }).click()
    await expect(guide(page)).toHaveCount(0)
    await page.getByRole('button', { name: '展开创作引导', exact: true }).click()
    await expect(choose).toContainText(`${label}1`)
    await choose.click()
    await page.getByRole('option', { name: `${label}2`, exact: true }).click()
    await remove(page, ids[1]!)
    await expect(guide(page)).toContainText(
      kind === 'board' ? '原分镜选择已失效' : '原交付序列已移除或不再关联',
    )
    expect(
      await page.evaluate(({ key, field }) => JSON.parse(localStorage.getItem(key)!)[field], {
        key: `plein:creation-guide:v1:${canvasId(page)}`,
        field: kind === 'board' ? 'boardId' : 'sequenceId',
      }),
    ).toBe(ids[1])
    await page.evaluate(() =>
      (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
    )
    await expect(choose).toContainText(`${label}2`)
    expect(f.submitted).toEqual([])
  })
}

test('已选分镜删除后不自动切到剩余分镜，撤销恢复与重新选择均可继续', async ({ page }) => {
  const f = await fixture(page, 2)
  const choose = guide(page).getByRole('combobox', { name: '创作引导分镜', exact: true })
  await choose.click()
  await page.getByRole('option', { name: '引导分镜2', exact: true }).click()
  await expect(choose).toContainText('引导分镜2')
  await remove(page, f.board)
  await expect(guide(page).locator('[data-guide-step]')).toHaveCount(0)
  await expect(choose).toBeVisible()
  await expect(guide(page)).toContainText('原分镜选择已失效')
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).boardId,
      `plein:creation-guide:v1:${canvasId(page)}`,
    ),
  ).toBe(f.board)
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await expect(choose).toContainText('引导分镜2')
  await expect(guide(page).locator('[data-guide-step]')).toHaveCount(6)
  await remove(page, f.board)
  await expect(guide(page).locator('[data-guide-step]')).toHaveCount(0)
  await choose.click()
  await page.getByRole('option', { name: '引导分镜1', exact: true }).click()
  await step(page, 'storyboard').click()
  await expect(
    page.getByRole('dialog', { name: '分镜表', exact: true }).getByLabel('画面', { exact: true }),
  ).toHaveValue('分镜1的画面')
  expect(f.submitted).toEqual([])
})

test('已选成片删除后不自动打开另一版，重新选择后定位正确序列', async ({ page }) => {
  const f = await fixture(page, 1, 2)
  const choose = guide(page).getByRole('combobox', { name: '创作引导交付序列', exact: true })
  await choose.click()
  await page.getByRole('option', { name: '引导成片2', exact: true }).click()
  await remove(page, f.films[1]!)
  await expect(step(page, 'delivery')).toBeDisabled()
  await expect(choose).toBeVisible()
  await expect(guide(page)).toContainText('原交付序列已移除或不再关联')
  await choose.click()
  await page.getByRole('option', { name: '引导成片1', exact: true }).click()
  await step(page, 'delivery').click()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.films[0]])
  await expect(page.getByRole('dialog', { name: '序列', exact: true })).toBeVisible()
  expect(f.submitted).toEqual([])
})

test('唯一成片同帧变为多个时旧交付按钮拒绝猜测，显式选择后可定位', async ({ page }) => {
  const f = await fixture(page)
  await step(page, 'delivery').evaluate((button, video) => {
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '新关联成片',
      x: 1800,
      y: 500,
      params: {},
    })
    if (!window.__plein.connect([video, 'video'], [id, 'clips']))
      throw new Error('fixture link failed')
    ;(button as HTMLButtonElement).click()
  }, f.video)
  await expect(page.getByRole('dialog', { name: '序列', exact: true })).toHaveCount(0)
  await expect(guide(page).getByRole('alert')).toContainText('定位目标已变化')
  await guide(page).getByRole('combobox', { name: '创作引导交付序列', exact: true }).click()
  await page.getByRole('option', { name: '新关联成片', exact: true }).click()
  await step(page, 'delivery').click()
  const selected = await page.evaluate(() => window.__plein.engine.selection.values())
  expect(selected).toHaveLength(1)
  expect(selected[0]).not.toBe(f.films[0])
  expect(f.submitted).toEqual([])
})

test('分镜同帧改变类型后拒绝旧定位，恢复类型后可重新打开', async ({ page }) => {
  const f = await fixture(page, 2)
  await guide(page).getByRole('combobox', { name: '创作引导分镜', exact: true }).click()
  await page.getByRole('option', { name: '引导分镜2', exact: true }).click()
  await step(page, 'storyboard').evaluate((button, id) => {
    ;(
      window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
    ).set('nodeType', 'plein/image')
    ;(button as HTMLButtonElement).click()
  }, f.board)
  await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toHaveCount(0)
  await expect(guide(page).getByRole('alert')).toContainText('分镜选择已变化')
  await page.evaluate((id) => {
    ;(
      window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
    ).set('nodeType', 'plein/storyboard')
  }, f.board)
  await expect(step(page, 'storyboard')).toBeEnabled()
  await step(page, 'storyboard').click()
  await expect(
    page.getByRole('dialog', { name: '分镜表', exact: true }).getByLabel('画面', { exact: true }),
  ).toHaveValue('分镜2的画面')
  expect(f.submitted).toEqual([])
})

test('人工核对同帧计划变化不写入旧确认，核对新计划后可确认并刷新保留', async ({ page }) => {
  const f = await fixture(page)
  const key = `plein:creation-guide:v1:${canvasId(page)}`
  const before = await page.evaluate((key) => localStorage.getItem(key), key)
  const confirm = guide(page).getByRole('button', {
    name: '我已人工核对这份分镜（仅本机）',
    exact: true,
  })
  await confirm.evaluate((button, id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      get(key: string): unknown
      set(key: string, value: unknown): void
    }
    const shots = params.get('shots') as Array<Record<string, unknown>>
    params.set(
      'shots',
      shots.map((shot) => ({ ...shot, description: '核对期间变更的画面' })),
    )
    ;(button as HTMLButtonElement).click()
  }, f.board)
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(before)
  await expect(guide(page).getByRole('alert')).toContainText('分镜计划已变化')
  await confirm.click()
  await expect(guide(page).locator('[data-guide-step="storyboard"]')).toHaveAttribute(
    'data-guide-state',
    'done',
  )
  await page.reload()
  await expect(guide(page).locator('[data-guide-step="storyboard"]')).toHaveAttribute(
    'data-guide-state',
    'done',
  )
  expect(f.submitted).toEqual([])
})

test('只读创作引导可打开已有样片，新建受限时说明原因并支持恢复重试', async ({ page }) => {
  const f = await fixture(page)
  const open = guide(page).getByRole('button', { name: '打开低成本分镜样片', exact: true })
  await open.click()
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toBeVisible()
  const animation = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/animatic')!.id,
  )
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.seq-editor')).toHaveCount(0)
  await page.evaluate((id) => {
    const { doc } = window.__plein.engine
    ;(doc as typeof doc & { readOnly: boolean }).readOnly = true
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
      'name',
      '只读引导分镜',
    )
  }, f.board)
  await expect(guide(page).getByText('只读引导分镜', { exact: true })).toBeVisible()
  await expect(open).toBeEnabled()
  await open.click()
  await expect(editor).toBeVisible()
  expect(
    await page.evaluate(() =>
      [...window.__plein.engine.doc.elements()]
        .filter((el) => el.nodeType === 'plein/animatic')
        .map((el) => el.id),
    ),
  ).toEqual([animation])
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.seq-editor')).toHaveCount(0)
  await page.evaluate(() => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = false
  })
  await remove(page, animation)
  await page.evaluate((id) => {
    const { doc } = window.__plein.engine
    ;(doc as typeof doc & { readOnly: boolean }).readOnly = true
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
      'name',
      '只读新建受限',
    )
  }, f.board)
  await open.click()
  await expect(guide(page).getByRole('alert')).toContainText('不能创建新样片')
  await expect(editor).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/animatic')
          .length,
    ),
  ).toBe(0)
  await page.evaluate((id) => {
    const { doc } = window.__plein.engine
    ;(doc as typeof doc & { readOnly: boolean }).readOnly = false
    ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
      'name',
      '已恢复新建权限',
    )
  }, f.board)
  await open.click()
  await expect(editor).toBeVisible()
  expect(f.submitted).toEqual([])
})

test('同名分镜与成片按短 ID 消歧，改名后仍定位原身份', async ({ page }) => {
  const f = await fixture(page, 2, 2, true)
  await page.setViewportSize({ width: 390, height: 700 })
  await page.getByRole('button', { name: '展开创作引导', exact: true }).click()
  const boards = guide(page).getByRole('combobox', { name: '创作引导分镜', exact: true })
  await boards.click()
  await page.getByRole('option', { name: `同名分镜 · ${f.board.slice(-6)}`, exact: true }).click()
  const films = guide(page).getByRole('combobox', { name: '创作引导交付序列', exact: true })
  await films.click()
  await page
    .getByRole('option', { name: `同名成片 · ${f.films[1]!.slice(-6)}`, exact: true })
    .click()
  await page.evaluate((id) => {
    ;(
      window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
    ).set('name', '改名后的第二版')
  }, f.films[1]!)
  await expect(films).toContainText('改名后的第二版')
  await expect(films).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.ui-select-popup:visible')).toHaveCount(0)
  await expect(films).toBeFocused()
  expect(await guide(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await guide(page).screenshot({ path: test.info().outputPath('guide-narrow-names.png') })
  await step(page, 'delivery').click()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.films[1]])
  expect(f.submitted).toEqual([])
})

test('采用候选同帧改变时拒绝旧审片定位，重新点击打开当前候选', async ({ page }) => {
  const f = await fixture(page)
  const image = await page.evaluate(
    (board) =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '引导审片图片',
        x: 600,
        y: 900,
        params: {
          model: 'plein/mock:image',
          prompt: '测试引导审片',
          source: { storyboard: board, shot: 'one', role: 'image' },
        },
      }),
    f.board,
  )
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvasId(page)}/nodes/${image}/input`)).status(),
    )
    .toBe(200)
  expect(
    (
      await page.request.post(`/api/canvases/${canvasId(page)}/nodes/${image}/run`, { data: {} })
    ).status(),
  ).toBe(202)
  await expect
    .poll(() =>
      page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length ?? 0, image),
    )
    .toBeGreaterThan(0)
  const navigationSubmissions = f.submitted.length
  await step(page, 'review').evaluate((button, id) => {
    const { doc } = window.__plein.engine
    const records = doc.get(id)!.results!
    const map = doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }
    map.set('results', [
      { ...records[0]!, id: 'new-guide-candidate', runId: 'new-guide-run', at: Date.now() },
      ...records,
    ])
    map.set('adopted', 'new-guide-candidate')
    ;(button as HTMLButtonElement).click()
  }, image)
  await expect(page.locator(`[data-review-node="${image}"]`)).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '查看「引导审片图片」', exact: true })).toHaveCount(
    0,
  )
  await expect(guide(page).getByRole('alert')).toContainText('定位目标已变化')
  await step(page, 'review').click()
  await expect(page.locator(`[data-review-node="${image}"]`)).toContainText('候选 andidate')
  expect(f.submitted).toHaveLength(navigationSubmissions)
})
