import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'
import type { Engine } from '../packages/canvas-core/src/engine'

for (const empty of [false, true]) {
  test(
    `真实协作版本升级立即只读并保留文档，空画布=${empty}`,
    empty ? {} : { tag: '@core' },
    async ({ page, context }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await newProject(page)
      if (!empty) {
        await page.evaluate(() =>
          window.__plein.addNode({
            type: 'plein/text',
            name: '升级前正文',
            params: { text: '必须保留' },
            x: 400,
            y: 240,
          }),
        )
        await page.getByRole('treeitem', { name: '升级前正文 定位到画布', exact: true }).click()
        await expect(page.getByTestId('generator')).toBeVisible()
      }
      const before = await page.evaluate(() => ({
        elements: [...window.__plein.engine.doc.elements()],
        edges: [...window.__plein.engine.doc.edges()],
      }))
      const peerContext = await context.browser()!.newContext()
      try {
        const peer = await peerContext.newPage()
        await peer.goto(page.url())
        await waitEngine(peer)
        await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
        await expect
          .poll(() => peer.evaluate(() => (window.__plein.engine as unknown as Engine).doc.size))
          .toBe(empty ? 0 : 1)
        await page.getByRole('button', { name: '添加节点', exact: true }).click()
        await expect(page.getByRole('textbox', { name: '搜索节点', exact: true })).toBeVisible()
        await peer.evaluate(() => {
          const doc = (window.__plein.engine as unknown as Engine).doc
          doc.ydoc.transact(
            () => doc.meta.set('schemaVersion', doc.schemaVersion + 1),
            'newer-client',
          )
        })
        await expect(page.getByRole('button', { name: '添加节点', exact: true })).toBeDisabled()
        await expect(
          page.getByText('这个画布已被新版本升级，当前只能查看，请刷新或更新应用', { exact: true }),
        ).toBeVisible()
        await expect(page.getByRole('textbox', { name: '搜索节点', exact: true })).toHaveCount(0)
        await expect(page.getByTestId('generator')).toHaveCount(0)
        await page.locator('canvas').evaluate((el) => (el.parentElement as HTMLElement).focus())
        await page.keyboard.press('Enter')
        await page.keyboard.press('Backspace')
        await page.keyboard.press('ControlOrMeta+z')
        expect(
          await page.evaluate(() => ({
            elements: [...window.__plein.engine.doc.elements()],
            edges: [...window.__plein.engine.doc.edges()],
          })),
        ).toEqual(before)
        await page.screenshot({
          path: test.info().outputPath(`schema-upgrade-${empty ? 'empty' : 'content'}.png`),
        })
        await page.reload()
        await waitEngine(page)
        await expect(page.getByRole('button', { name: '添加节点', exact: true })).toBeDisabled()
        expect(
          await page.evaluate(() => ({
            elements: [...window.__plein.engine.doc.elements()],
            edges: [...window.__plein.engine.doc.edges()],
          })),
        ).toEqual(before)
        expect(errors).toEqual([])
      } finally {
        await peerContext.close()
      }
    },
  )
}
