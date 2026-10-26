import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, openStoryboardActions, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '分镜数据恢复',
      x: 300,
      y: 200,
      params: {
        shots: [
          { id: 'one', no: 1, duration: 3, description: '保留第一镜' },
          {
            id: 'two',
            no: 2,
            duration: 4,
            description: '保留第二镜',
            lighting: '柔和晨光',
            custom: 'keep',
          },
        ],
      },
    }),
  )
  const open = async () => {
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
  }
  await open()
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  await editor.getByRole('button', { name: '详细卡片', exact: true }).click()
  await openStoryboardActions(editor)
  await expect(editor.getByRole('article')).toHaveCount(2)
  const read = () => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.shots, id)
  const write = (shots: unknown) =>
    page.evaluate(
      ({ id, shots }) => {
        const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
          set(k: string, v: unknown): void
        }
        params.set('shots', shots)
      },
      { id, shots },
    )
  return { id, editor, open, read, write }
}

test('异常镜头不再被静默隐藏，可只恢复无效字段并撤销重做', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  const f = await fixture(page)
  const before = (await f.read()) as Array<Record<string, unknown>>
  const broken = [before[0], { ...before[1], duration: -2 }]
  await f.write(broken)
  const problem = page.getByRole('dialog', { name: '分镜数据问题', exact: true })
  await expect(problem.getByRole('alert')).toContainText('第 2 行')
  await expect(problem).toContainText('时长')
  expect(await f.read()).toEqual(broken)
  await problem.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(problem).not.toBeVisible()
  await f.open()
  await problem.getByRole('button', { name: '恢复第 2 行无效字段', exact: true }).click()
  await expect(f.editor.getByRole('article')).toHaveCount(2)
  expect(await f.read()).toEqual([before[0], { ...before[1], duration: 5 }])
  await f.editor.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(problem).toBeVisible()
  expect(await f.read()).toEqual(broken)
  await problem.getByRole('button', { name: '重做', exact: true }).click()
  await expect(f.editor.getByRole('article')).toHaveCount(2)
})

test('列表恢复说明清楚，只读不能写入，整表重置可撤销并继续添加', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  const f = await fixture(page)
  const before = (await f.read()) as Array<Record<string, unknown>>
  const broken = [before[0], { ...before[1], dialogue: [{ character: '甲', line: 7 }] }]
  await f.write(broken)
  const problem = page.getByRole('dialog', { name: '分镜数据问题', exact: true })
  await expect(problem).toContainText('台词列表会整体重置')
  const readOnly = (value: boolean) =>
    page.evaluate((value) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        refreshState(): void
      }
      ;(engine.doc as typeof engine.doc & { readOnly: boolean }).readOnly = value
      engine.refreshState()
    }, value)
  await readOnly(true)
  const restore = problem.getByRole('button', { name: '恢复第 2 行无效字段', exact: true })
  await expect(restore).toBeDisabled()
  await expect(problem.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  expect(await f.read()).toEqual(broken)
  await readOnly(false)
  await restore.scrollIntoViewIfNeeded()
  await expect(restore).toBeInViewport({ ratio: 1 })
  expect(await problem.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await problem.screenshot({
    path: test.info().outputPath('dialogue-list-recovery-390.png'),
    animations: 'disabled',
  })
  await restore.click()
  await expect(f.editor.getByRole('article')).toHaveCount(2)
  expect(await f.read()).toEqual([before[0], { ...before[1], dialogue: [] }])
  const description = f.editor.getByRole('article').last().getByLabel('画面', { exact: true })
  await description.fill('修复后仍可编辑')
  await description.blur()
  await expect
    .poll(async () => ((await f.read()) as Array<Record<string, unknown>>)[1]!.description)
    .toBe('修复后仍可编辑')
  await f.write(null)
  await expect(problem).toContainText('重置会将损坏的镜头列表清空')
  await problem.getByRole('button', { name: '重置镜头列表', exact: true }).click()
  await expect(f.editor.getByRole('article')).toHaveCount(0)
  expect(await f.read()).toEqual([])
  await f.editor.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(problem).toBeVisible()
  expect(await f.read()).toBeNull()
  await problem.getByRole('button', { name: '重做', exact: true }).click()
  await f.editor.getByRole('button', { name: '添加镜头', exact: true }).click()
  await expect(f.editor.getByRole('article')).toHaveCount(1)
})

test('重复及空镜头标识显式修复，旧素材仍关联原镜头，重做保留新标识', async ({ page }) => {
  const f = await fixture(page)
  const before = (await f.read()) as Array<Record<string, unknown>>
  const source = await page.evaluate(
    (board) =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '原镜头素材',
        x: 900,
        y: 200,
        params: { source: { storyboard: board, shot: 'one', role: 'image' } },
      }),
    f.id,
  )
  const readSource = () =>
    page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.source, source)
  const originalSource = await readSource()
  await f.write([
    before[0],
    { ...before[1], id: 'one' },
    { id: '', no: 3, description: '保留第三镜' },
  ])
  const problem = page.getByRole('dialog', { name: '分镜数据问题', exact: true })
  await expect(problem).toContainText('已有素材仍关联原标识')
  await problem.getByRole('button', { name: '恢复第 2 行无效字段', exact: true }).click()
  await expect(
    problem.getByRole('button', { name: '恢复第 2 行无效字段', exact: true }),
  ).toHaveCount(0)
  await problem.getByRole('button', { name: '恢复第 3 行无效字段', exact: true }).click()
  await expect(f.editor.getByRole('article')).toHaveCount(3)
  const fixed = (await f.read()) as Array<Record<string, unknown>>
  expect(new Set(fixed.map((s) => s.id)).size).toBe(3)
  expect(fixed[0]).toEqual(before[0])
  expect(fixed[1]).toMatchObject({ description: '保留第二镜', custom: 'keep' })
  expect(await readSource()).toEqual(originalSource)
  await f.editor.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(problem).toContainText('第 3 行')
  await problem.getByRole('button', { name: '重做', exact: true }).click()
  await expect(f.editor.getByRole('article')).toHaveCount(3)
  expect(await f.read()).toEqual(fixed)
  expect(await readSource()).toEqual(originalSource)
})

test('旧添加和恢复按钮不会覆盖同帧到达的异常或协作数据', async ({ page }) => {
  const f = await fixture(page)
  const before = (await f.read()) as Array<Record<string, unknown>>
  const broken = [before[0], { ...before[1], duration: -2 }]
  await f.editor.getByRole('button', { name: '添加镜头', exact: true }).evaluate(
    (button, { id, broken }) => {
      const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
        set(k: string, v: unknown): void
      }
      params.set('shots', broken)
      ;(button as HTMLButtonElement).click()
    },
    { id: f.id, broken },
  )
  const problem = page.getByRole('dialog', { name: '分镜数据问题', exact: true })
  await expect(problem).toBeVisible()
  expect(await f.read()).toEqual(broken)
  const changed = [{ ...before[0], description: '协作写入的画面' }, broken[1]]
  const restore = problem.getByRole('button', { name: '恢复第 2 行无效字段', exact: true })
  await restore.evaluate(
    (button, { id, changed }) => {
      const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
        set(k: string, v: unknown): void
      }
      params.set('shots', changed)
      ;(button as HTMLButtonElement).click()
    },
    { id: f.id, changed },
  )
  await expect(page.locator('.ui-toast')).toContainText('数据已变化')
  expect(await f.read()).toEqual(changed)
  await restore.click()
  await expect(f.editor.getByRole('article')).toHaveCount(2)
  expect(await f.read()).toEqual([changed[0], { ...before[1], duration: 5 }])
})

test('删除确认期间其他镜头损坏，不删除任何镜头或脱离已有素材', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await fixture(page)
  await f.editor.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(f.editor).not.toBeVisible()
  await f.open()
  await expect(f.editor.getByRole('article')).toHaveCount(2)
  const nodes = () =>
    page.evaluate(
      (id) =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => (el.params?.source as { storyboard?: string })?.storyboard === id)
          .map((el) => ({ id: el.id, params: el.params })),
      f.id,
    )
  const material = await nodes()
  expect(material.length).toBeGreaterThan(0)
  const before = (await f.read()) as Array<Record<string, unknown>>
  await f.editor.getByRole('button', { name: '删除镜头 1', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除镜头 01？', exact: true })
  await expect(confirmation).toBeVisible()
  const broken = [before[0], { ...before[1], duration: -2 }]
  await f.write(broken)
  // 编辑器可能先发现数据损坏并直接收起确认框；还开着时再点删除，两条路径都不能删掉镜头。
  const remove = confirmation.getByRole('button', { name: '删除镜头', exact: true })
  await remove.click({ timeout: 2_000 }).catch(() => expect(confirmation).not.toBeVisible())
  await expect(confirmation).not.toBeVisible()
  await expect(page.getByRole('dialog', { name: '分镜数据问题', exact: true })).toBeVisible()
  expect(await f.read()).toEqual(broken)
  expect(await nodes()).toEqual(material)
  expect(errors).toEqual([])
})
