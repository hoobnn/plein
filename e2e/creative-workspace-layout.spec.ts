import { expect, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

test('镜头制作同屏布局、切镜草稿和冲突保护，浏览不触发生成', async ({ page }, info) => {
  const executions: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(run|run-flow|run-batch|commit)$/.test(new URL(request.url()).pathname)
    )
      executions.push(request.url())
  })
  await newProject(page)
  const shots = Array.from({ length: 12 }, (_, index) => ({
    id: `layout-shot-${index + 1}`,
    no: index + 1,
    duration: 5,
    description: `镜头 ${index + 1} 的原始画面描述`,
    shotSize: '中景',
    characters: ['林夏', '雨夜街道'],
    dialogue: [],
    imagePrompt: '雨夜的街道，电影感',
    motionPrompt: '缓慢向前推进',
    lighting: '路灯的暖光',
  }))
  const board = await page.evaluate(
    (shots) =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '连续镜头制作',
        params: { shots },
        x: 100,
        y: 100,
      }),
    shots,
  )
  await zoomTo(page, [board])
  const point = await centerOf(page, board)
  await page.mouse.dblclick(point.x, point.y)
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  await editor.getByRole('button', { name: '详细卡片', exact: true }).click()
  await editor.getByRole('button', { name: '镜头 1 工作台', exact: true }).click()
  const workspace = page.getByRole('dialog', { name: '镜头工作台', exact: true })
  const field = workspace.getByRole('textbox', { name: '工作台画面描述', exact: true })
  await expect(workspace).toBeVisible()
  for (const width of [1440, 1224, 768, 390]) {
    await page.setViewportSize({ width, height: 763 })
    await expect
      .poll(() =>
        workspace.evaluate((el) => {
          const box = el.getBoundingClientRect()
          const nav = el.querySelector('[aria-label="镜头导航"]')!.getBoundingClientRect()
          const close = el.querySelector('button[aria-label="关闭"]')!.getBoundingClientRect()
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.bottom <= innerHeight &&
            nav.bottom <= box.bottom &&
            close.right <= box.right &&
            el.scrollWidth <= el.clientWidth
          )
        }),
      )
      .toBe(true)
    if (width >= 1224) {
      // 同一帧测量两列，避免弹窗进场动画期间跨帧读取产生假错位。
      await expect
        .poll(() =>
          workspace.evaluate((el) => {
            const plan = el.querySelector('[aria-label="当前镜头计划"]')!.getBoundingClientRect()
            const preview = el
              .querySelector('[aria-label="本镜候选与执行依据"]')!
              .getBoundingClientRect()
            return plan.right <= preview.left + 1 && Math.abs(plan.y - preview.y) < 2
          }),
        )
        .toBe(true)
    }
    await workspace.screenshot({ path: info.outputPath(`workspace-${width}.png`) })
  }
  await page.setViewportSize({ width: 1224, height: 763 })
  await field.fill('第一镜尚未保存的修改')
  await workspace.getByRole('button', { name: '下一镜', exact: true }).click()
  await expect(field).toHaveValue(shots[1]!.description)
  await field.fill('第二镜尚未保存的修改')
  await workspace.getByRole('button', { name: '上一镜', exact: true }).click()
  await expect(field).toHaveValue('第一镜尚未保存的修改')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.shots, board),
  ).toEqual(shots)
  await workspace.getByRole('button', { name: '切换到镜头 12', exact: true }).click()
  await expect(workspace.getByRole('button', { name: '下一镜', exact: true })).toBeDisabled()
  await workspace.getByRole('button', { name: '切换到镜头 1', exact: true }).click()
  await expect(field).toHaveValue('第一镜尚未保存的修改')
  // 模拟另一端在切镜期间更新原镜，旧草稿仍保留，但不能覆盖新版。
  await page.evaluate(
    ({ board, shots }) => {
      const params = window.__plein.engine.doc.mutable(board)!.get('params') as {
        set(key: string, value: unknown): void
      }
      params.set(
        'shots',
        shots.map((shot, index) => (index ? shot : { ...shot, description: '另一端的新版本' })),
      )
    },
    { board, shots },
  )
  await expect(workspace.getByRole('button', { name: '保存本镜字段', exact: true })).toBeDisabled()
  await expect(field).toHaveValue('第一镜尚未保存的修改')
  await workspace.getByRole('button', { name: '重新载入本镜', exact: true }).click()
  await expect(field).toHaveValue('另一端的新版本')
  await workspace.getByRole('button', { name: '返回分镜表', exact: true }).click()
  await expect(workspace).toBeHidden()
  await expect(editor).toBeVisible()
  expect(executions).toEqual([])
})

test('空画布快捷创建可撤销，不会生成；只读状态不提供创建入口', async ({ page }, info) => {
  const executions: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(run|run-flow|run-batch|commit)$/.test(new URL(request.url()).pathname)
    )
      executions.push(request.url())
  })
  await newProject(page)
  await page.screenshot({ path: info.outputPath('canvas-start.png') })
  for (const title of ['角色', '场景', '图片', '视频']) {
    await page.getByRole('button', { name: `新建${title}节点`, exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
      .toBe(1)
    await page.evaluate(() =>
      (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
    )
    await expect(page.getByRole('button', { name: `新建${title}节点`, exact: true })).toBeVisible()
  }
  await page.evaluate(() => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      schemaVersion: number
      meta: { set(key: string, value: unknown): void }
    }
    doc.meta.set('schemaVersion', doc.schemaVersion + 1)
  })
  await expect(page.getByRole('button', { name: '新建角色节点', exact: true })).toHaveCount(0)
  expect(executions).toEqual([])
})
