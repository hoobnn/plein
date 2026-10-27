import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ProjectPackageManifest } from '../packages/protocol/src/project-package'
import { expect, test, type Locator } from './fixtures'
import { newProject, revealGenerator, waitEngine, waitNode } from './canvas'

const { strFromU8, unzipSync } = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
)('fflate') as {
  strFromU8(data: Uint8Array): string
  unzipSync(data: Uint8Array): Record<string, Uint8Array>
}

/** 项目和画布的增删改：画布页改过的东西回到首页能看到（列表数据走查询缓存，改完要失效重拉） */
test('项目改名、加画布、首页重命名和删除', { tag: '@core' }, async ({ page }) => {
  const name = `项目 ${Date.now()}`
  await newProject(page)

  // 页头改项目名
  await page.getByTitle('重命名项目').click()
  await page.getByRole('textbox').fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()

  // 新建第二张画布，下拉里两张都在
  await page.getByRole('button', { name: '切换画布' }).click()
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('第二张')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '切换画布' })).toHaveText('第二张')
  await waitEngine(page)
  await page.getByRole('button', { name: '切换画布' }).click()
  const menu = page.getByRole('dialog', { name: '画布' })
  await expect(menu.getByRole('button')).toHaveCount(5) // 两张画布 + 新建、重命名、删除
  await page.keyboard.press('Escape')

  // 回首页：改过的名字和画布数都是新的
  await page.goto('/')
  const card = page.getByRole('listitem').filter({ hasText: name })
  await expect(card).toContainText('2 张画布')
  const title = card.getByRole('link', { name, exact: true })
  // 隐藏操作不占据正文宽度，否则五个按钮会把标题和画布数挤成几个字。
  expect((await title.boundingBox())!.width).toBeGreaterThan(
    (await card.boundingBox())!.width * 0.8,
  )
  await expect(title).toHaveAttribute('title', name)
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  await card.hover()
  await card.getByRole('button', { name: '重命名' }).click()
  await page.locator('.home-card input').fill(`${name} 改`)
  await page.keyboard.press('Enter')
  const renamed = page.getByRole('listitem').filter({ hasText: `${name} 改` })
  await expect(renamed).toBeVisible()

  await page.setViewportSize({ width: 800, height: 900 })
  const renamedTitle = renamed.getByRole('link', { name: `${name} 改`, exact: true })
  expect((await renamedTitle.boundingBox())!.width).toBeGreaterThan(
    (await renamed.boundingBox())!.width * 0.8,
  )
  await renamedTitle.focus()
  await expect(renamed.locator('.home-card-actions')).toHaveCSS('opacity', '1')

  await renamed.hover()
  await renamed.getByRole('button', { name: '删除' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await expect(renamed).toHaveCount(0)
})

/**
 * 项目包：带多个候选的项目导出（默认只带采用项，可选全部历史候选），再导入同一个包，
 * 作为副本出现并打开画布，采用结果保持不变。
 */
test('导出项目包再导入：默认仅采用项，副本保留采用结果', { tag: '@core' }, async ({ page }) => {
  const name = `迁移 ${Date.now()}`
  await newProject(page)
  await page.getByTitle('重命名项目').click()
  await page.getByRole('textbox').fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()

  // 双候选：默认导出只带采用的那张，开关后两张都进包
  const node = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '双候选',
      params: { model: 'plein/mock:image', prompt: '透明水杯', count: 2 },
      x: 400,
      y: 200,
    }),
  )
  const canvasId = new URL(page.url()).hash.split('/').at(-1)!
  expect(
    (await page.request.post(`/api/canvases/${canvasId}/nodes/${node}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, node, 30_000)
  const adopted = await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, node)

  await page.goto('/')
  const card = page.getByRole('listitem').filter({ hasText: name })
  await card.hover()
  await card.getByRole('button', { name: '导出项目包' }).click()
  const dialog = page.getByRole('dialog', { name: '导出项目包' })
  await expect(dialog).toContainText('平台密钥')
  await expect(dialog).toContainText('1 张画布')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: '导出' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.plein$/)
  const file = (await download.path())!
  // 默认范围：清单声明仅当前采用项，素材也只有被采用的那张
  const manifest = JSON.parse(
    strFromU8(unzipSync(readFileSync(file))['manifest.json']!),
  ) as ProjectPackageManifest
  expect(manifest.candidates).toBe('current')
  expect(manifest.assets).toHaveLength(1)

  await page.getByTestId('project-import-input').setInputFiles(file)
  const preview = page.getByRole('dialog', { name: `导入「${name}」` })
  await expect(preview).toContainText('会作为副本导入')
  await preview.getByRole('button', { name: '作为副本导入' }).click()
  await waitEngine(page)
  await expect(page.getByRole('button', { name: `${name}（副本）`, exact: true })).toBeVisible()
  // 副本里的节点只保留采用的那张结果，采用项不变
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, node))
    .toBe(1)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, node)).toBe(
    adopted,
  )
})

/**
 * 定位任务目标后的实际可见与可点击（合并自 task-mobile-locate / task-viewport-layout /
 * home-agent-layout 的遮挡验收）：窄屏定位先收面板，桌面目标落在两侧面板之间；
 * 首页窄屏卡片标题右侧点击不被助手开关截获。
 */
for (const width of [320, 1440] as const) {
  test(`任务定位后目标与操作区实际可达（${width}px）`, { tag: '@core' }, async ({ page }) => {
    await newProject(page)
    const title = `定位遮挡检查 ${Date.now()}`
    await page.getByTitle('重命名项目').click()
    await page.getByRole('textbox').fill(title)
    await page.keyboard.press('Enter')

    // 首页：窄屏时卡片标题最右侧的点击必须命中标题（不被悬浮的助手开关截获）
    await page.goto('/')
    await page.setViewportSize({ width, height: 900 })
    const link = page.getByRole('link', { name: title, exact: true })
    await expect(link).toBeVisible()
    const box = (await link.boundingBox())!
    await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2)
    await waitEngine(page)
    expect(new URL(page.url()).hash).toMatch(/#\/c\//)

    // 远处的节点 + 一条任务记录：从任务面板定位它
    const node = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '定位目标节点',
        params: { prompt: '透明水杯', model: 'plein/mock:image' },
        x: 3000,
        y: 2000,
      }),
    )
    await page.route('**/api/canvases/*/jobs', (route) =>
      route.fulfill({
        json: {
          jobs: [
            {
              id: 'locate-job',
              nodeId: node,
              nodeType: 'plein/image',
              status: 'succeeded',
              attempts: 1,
              createdAt: Date.now(),
            },
          ],
          groups: [],
        },
      }),
    )
    await page.getByRole('button', { name: '任务', exact: true }).click()
    const tasks = page.getByRole('complementary', { name: '任务', exact: true })
    await tasks.getByRole('button', { name: '定位目标节点', exact: true }).click()

    // 窄屏定位先收起全宽面板；桌面上面板保留，目标要落在侧栏与任务面板之间
    const sidebar = page.getByRole('complementary', {
      name: '侧栏',
      exact: true,
      includeHidden: true,
    })
    await expect
      .poll(async () => {
        const hidden = (await sidebar.getAttribute('aria-hidden')) === 'true'
        const side = (await sidebar.boundingBox())!
        const left = hidden ? 0 : side.x + side.width
        const panel = await tasks.boundingBox()
        const right = panel && !hidden ? panel.x : width
        return page.evaluate(
          ({ id, left, right }) => {
            const engine = window.__plein.engine
            const r = engine.doc.worldRect(id)
            const a = engine.worldToClient(r.x, r.y)
            const b = engine.worldToClient(r.x + r.w, r.y + r.h)
            return a.x >= left + 8 && b.x <= right - 8 && a.y >= 64 && b.y <= 836
          },
          { id: node, left, right },
        )
      })
      .toBe(true)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([node])

    // 底部工具条与快捷键入口不被面板遮挡：实际点击命中
    const hit = (target: Locator) =>
      target.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return (
          r.x >= 0 &&
          r.right <= innerWidth &&
          document
            .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            ?.closest(el.tagName === 'BUTTON' ? 'button' : '[data-testid]') === el
        )
      })
    expect(await hit(page.getByRole('button', { name: '快捷键', exact: true }))).toBe(true)
    // 节点编辑器固定 840px 宽，窄窗口里放不下整块：把它移进窗口再验生成按钮
    const generator = page.getByTestId('generator')
    const generate = generator.getByRole('button', { name: '生成', exact: true })
    await revealGenerator(page, generate)
    expect(await hit(generate)).toBe(true)
    await expect(generate).toBeEnabled()
  })
}
