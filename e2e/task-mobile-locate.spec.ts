import { expect, test } from '@playwright/test'
import { newProject, settle } from './canvas'

for (const width of [320, 639])
  for (const target of ['node', 'frame', 'batch'] as const) {
    test(`${width}px 任务定位 ${target} 后收起全宽面板并显示目标，侧栏偏好保留`, async ({
      page,
    }) => {
      await newProject(page)
      const ids = await page.evaluate(() => {
        const node = window.__plein.addNode({
          type: 'plein/image',
          name: '手机定位图片',
          params: { prompt: '透明水杯', model: 'plein/mock:image' },
          x: 3000,
          y: 2000,
        })
        const other = window.__plein.addNode({
          type: 'plein/text',
          name: '手机分组边界',
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
      await page.setViewportSize({ width, height: 900 })
      await page.route('**/api/canvases/*/jobs', (route) =>
        route.fulfill({
          json: {
            jobs: [
              {
                id: 'mobile-job',
                nodeId: ids.node,
                nodeType: 'plein/image',
                status: 'succeeded',
                attempts: 1,
                createdAt: Date.now(),
              },
            ],
            groups: [
              {
                id: 'mobile-group',
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
      await page.route('**/api/runs/groups/mobile-group/items', (route) =>
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
      const id = target === 'frame' ? ids.frame : ids.node
      if (target === 'batch') {
        await tasks.getByRole('button', { name: '批次记录', exact: true }).click()
        await tasks
          .getByRole('list', { name: '批次记录', exact: true })
          .getByRole('button', { name: '手机定位图片', exact: true })
          .click()
      } else
        await tasks
          .getByRole('button', { name: target === 'frame' ? '分组' : '手机定位图片', exact: true })
          .click()
      await expect(tasks).toHaveCount(0, { timeout: 1500 })
      const sidebar = page.getByRole('complementary', {
        name: '侧栏',
        exact: true,
        includeHidden: true,
      })
      await expect(sidebar).toHaveAttribute('aria-hidden', width < 604 ? 'true' : 'false')
      await expect
        .poll(async () => {
          const hidden = (await sidebar.getAttribute('aria-hidden')) === 'true'
          const box = (await sidebar.boundingBox())!
          const left = hidden ? 0 : box.x + box.width
          return page.evaluate(
            ({ id, left, width }) => {
              const engine = window.__plein.engine
              const r = engine.doc.worldRect(id)
              const a = engine.worldToClient(r.x, r.y)
              const b = engine.worldToClient(r.x + r.w, r.y + r.h)
              return a.x >= left + 8 && b.x <= width - 8 && a.y >= 64 && b.y <= 836
            },
            { id, left, width },
          )
        })
        .toBe(true)
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
      const tools =
        target === 'frame'
          ? page.getByRole('toolbar', { name: 'Frame 操作', exact: true })
          : page.getByTestId('generator')
      await expect(tools).toBeVisible()
      const bounds = (await tools.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(4)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 4)
      expect(
        await page.getByRole('button', { name: '快捷键', exact: true }).evaluate((button) => {
          const r = button.getBoundingClientRect()
          return (
            document.elementFromPoint(r.right - 2, r.y + r.height / 2)?.closest('button') === button
          )
        }),
      ).toBe(true)
      if (target !== 'frame') {
        const generate = tools.getByRole('button', { name: '生成', exact: true })
        await expect(generate).toBeEnabled()
        expect(
          await generate.evaluate((button) => {
            const r = button.getBoundingClientRect()
            return (
              document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest('button') === button
            )
          }),
        ).toBe(true)
        const canvas = new URL(page.url()).hash.split('/').at(-1)!
        const started = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/canvases/${canvas}/nodes/${id}/run`) &&
            response.request().method() === 'POST',
        )
        await generate.click()
        expect((await started).status()).toBe(202)
        await expect
          .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, id))
          .toBe('succeeded')
        await expect
          .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
          .toBe(1)
        await expect
          .poll(() =>
            page.evaluate(() => {
              const stats = (
                window.__plein.engine as unknown as {
                  stats: {
                    textures: { readyTextures: number }
                    previewRevision: number
                    renderedPreviewRevision: number
                  }
                }
              ).stats
              return (
                stats.textures.readyTextures > 0 &&
                stats.previewRevision === stats.renderedPreviewRevision
              )
            }),
          )
          .toBe(true)
        await settle(page, id)
      }
      expect(await page.evaluate(() => localStorage.getItem('plein:sidebar'))).not.toBe('closed')
      await page.screenshot({
        path: test.info().outputPath('mobile-located.png'),
        animations: 'disabled',
      })
      if (width < 604) {
        await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
        await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
        await page.getByRole('button', { name: '任务', exact: true }).click()
        await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
        await tasks.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
      }
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
    })
  }
