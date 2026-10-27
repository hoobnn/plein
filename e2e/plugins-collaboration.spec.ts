import { openCanvasSettings } from './settings-ui'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { elements, newProject, waitEngine } from './canvas'
import { slowFile } from './slow-file'

async function openPlugins(page: Page) {
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^插件/ }).click()
  return { settings, toggle: settings.locator('[data-plugin="acme/echo"]').getByRole('switch') }
}

/**
 * 两个独立客户端连同一个服务端：一边启停，另一边已经打开的面板和节点目录都要跟上。
 * 面板靠轮询发现变化、目录靠重新读取跟上，这段跨客户端同步只有真浏览器加真服务端能证明。
 */
test(
  '另一客户端启停插件时，已打开的插件面板和随后使用的节点目录同步',
  { tag: '@core' },
  async ({ page, context, request }) => {
    const directory = join(process.env.PLEIN_E2E_DATA!, 'plugins/acme-echo')
    execFileSync(process.execPath, [
      join(import.meta.dirname, '../examples/plugins/acme-echo/build.mjs'),
      directory,
    ])
    await request.post('/api/plugins/local/rescan')
    await request.put('/api/plugins/local/acme/echo', { data: { enabled: false } })
    await newProject(page)
    const local = await openPlugins(page)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      const other = await openPlugins(peer)
      await expect(local.toggle).not.toBeChecked()
      // 主页面先读到启用过程中的旧目录；关闭设置后首次使用节点时仍须跟进新目录。
      const oldCatalog = await (await request.get('/api/catalog')).json()
      let staleReads = 0
      await page.route('**/api/catalog', (route) => {
        staleReads++
        return route.fulfill({ json: oldCatalog })
      })
      await other.toggle.click()
      await expect(other.toggle).toBeEnabled()
      await expect(local.toggle).toBeChecked()
      await expect.poll(() => staleReads).toBeGreaterThan(0)
      await page.unroute('**/api/catalog')
      await page.keyboard.press('Escape')
      await expect(local.settings).toHaveCount(0)
      // 目录跟上以后，节点出现在添加菜单里
      await page.getByRole('button', { name: '添加节点', exact: true }).click()
      const picker = page.getByRole('dialog', { name: '添加节点', exact: true })
      await picker.getByRole('textbox', { name: '搜索节点', exact: true }).fill('大声说')
      await expect(picker.getByRole('option', { name: '大声说', exact: true })).toBeVisible()
      await picker.getByRole('option', { name: '大声说', exact: true }).click()
      const node = (await elements(page)).find((element) => element.nodeType === 'acme/shout')!
      await page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
        .fill('two clients')
      // 另一端停用：面板和目录都跟着撤下，画布上已有的节点保留
      const reopened = await openPlugins(page)
      await other.toggle.click()
      await expect(other.toggle).toBeEnabled()
      await expect(reopened.toggle).not.toBeChecked()
      await page.keyboard.press('Escape')
      await expect(reopened.settings).toHaveCount(0)
      await page.getByRole('button', { name: '添加节点', exact: true }).click()
      await picker.getByRole('textbox', { name: '搜索节点', exact: true }).fill('大声说')
      await expect(picker.getByRole('option', { name: '大声说', exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.text, node.id),
      ).toBe('two clients')
    } finally {
      await peerContext.close()
      await request.put('/api/plugins/local/acme/echo', { data: { enabled: false } })
    }
  },
)

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
