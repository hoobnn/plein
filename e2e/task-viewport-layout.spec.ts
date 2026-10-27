import { expect, test } from './fixtures'
import { newProject, revealGenerator } from './canvas'

for (const width of [1440, 900])
  for (const target of ['node', 'frame', 'batch'] as const) {
    test(`${width}px 任务面板定位 ${target} 时目标和操作区避开两侧面板`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await newProject(page)
      const ids = await page.evaluate(() => {
        const node = window.__plein.addNode({
          type: 'plein/image',
          name: '定位图片',
          params: {},
          x: 3000,
          y: 2000,
        })
        const other = window.__plein.addNode({
          type: 'plein/text',
          name: '分组边界',
          params: {},
          x: 4400,
          y: 2100,
        })
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          groupSelection(): void
        }
        engine.selection.set([node, other])
        engine.groupSelection()
        engine.selection.set([])
        return { node, frame: [...engine.doc.elements()].find((el) => el.kind === 'frame')!.id }
      })
      await page.route('**/api/canvases/*/jobs', (route) =>
        route.fulfill({
          json: {
            jobs: [
              {
                id: 'layout-job',
                nodeId: ids.node,
                nodeType: 'plein/image',
                status: 'succeeded',
                attempts: 1,
                createdAt: Date.now(),
              },
            ],
            groups: [
              {
                id: 'layout-group',
                frameId: ids.frame,
                scope: 'frame',
                status: 'done',
                total: 1,
                createdAt: Date.now(),
              },
            ],
          },
        }),
      )
      await page.route('**/api/runs/groups/layout-group/items', (route) =>
        route.fulfill({
          json: [
            {
              nodeId: ids.node,
              seq: 0,
              stage: 'run',
              deps: [],
              outcome: 'succeeded',
              updatedAt: Date.now(),
            },
          ],
        }),
      )
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const tasks = page.getByRole('complementary', { name: '任务', exact: true })
      const nodeId = target === 'frame' ? ids.frame : ids.node
      if (target === 'batch') {
        await tasks.getByRole('button', { name: '批次记录', exact: true }).click()
        await tasks
          .getByRole('list', { name: '批次记录', exact: true })
          .getByRole('button', { name: '定位图片', exact: true })
          .click()
      } else
        await tasks
          .getByRole('button', { name: target === 'frame' ? '分组' : '定位图片', exact: true })
          .click()
      const visible = async () => {
        const panel = (await tasks.boundingBox())!
        const sidebar = page.getByRole('complementary', {
          name: '侧栏',
          exact: true,
          includeHidden: true,
        })
        const left =
          (await sidebar.getAttribute('aria-hidden')) === 'true'
            ? 0
            : (await sidebar.boundingBox())!.x + (await sidebar.boundingBox())!.width
        const rect = await page.evaluate((id) => {
          const engine = window.__plein.engine
          const r = engine.doc.worldRect(id)
          return {
            a: engine.worldToClient(r.x, r.y),
            b: engine.worldToClient(r.x + r.w, r.y + r.h),
          }
        }, nodeId)
        return rect.a.x >= left + 8 && rect.b.x <= panel.x - 8 && rect.a.y >= 64 && rect.b.y <= 836
      }
      await expect.poll(visible).toBe(true)
      const tools =
        target === 'frame'
          ? page.getByRole('toolbar', { name: 'Frame 操作', exact: true })
          : page.getByTestId('generator')
      await expect(tools).toBeVisible()
      if (target === 'frame') {
        await expect
          .poll(async () => {
            const box = (await tools.boundingBox())!
            const panel = (await tasks.boundingBox())!
            const sidebar = page.getByRole('complementary', {
              name: '侧栏',
              exact: true,
              includeHidden: true,
            })
            const side = (await sidebar.boundingBox())!
            const left =
              (await sidebar.getAttribute('aria-hidden')) === 'true' ? 0 : side.x + side.width
            return box.x >= left + 4 && box.x + box.width <= panel.x - 4
          })
          .toBe(true)
      } else {
        // 节点编辑器固定 840px 宽，和两侧面板并排时放不进中间：
        // 把它移进窗口，生成按钮要点得到就行
        const generate = tools.getByRole('button', { name: '生成', exact: true })
        await revealGenerator(page, generate)
        await expect(generate).toBeInViewport({ ratio: 1 })
      }
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([nodeId])
      await page.screenshot({
        path: test.info().outputPath('task-locate.png'),
        animations: 'disabled',
      })
      await tasks.getByRole('button', { name: '关闭', exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window.__plein.engine as unknown as { camera: { insets: { right: number } } }).camera
                .insets.right,
          ),
        )
        .toBe(0)
      await expect(page.getByRole('complementary', { name: '侧栏', exact: true })).toHaveAttribute(
        'aria-hidden',
        'false',
      )
    })
  }
