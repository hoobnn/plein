import { openCanvasSettings } from './settings-ui'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { addNode, clickElement, elements, newProject, revealGenerator, waitNode } from './canvas'

test('运行中反复崩溃更新设置状态，修复重载后原节点可继续执行', async ({ page, request }) => {
  const directory = join(process.env.PLEIN_E2E_DATA!, 'plugins/acme-echo')
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../examples/plugins/acme-echo/build.mjs'),
    directory,
  ])
  const entry = join(directory, 'dist/server.mjs')
  const original = readFileSync(entry, 'utf8')
  const endpoint = '/api/plugins/local/acme/echo'
  await request.post('/api/plugins/local/rescan')
  try {
    // 保留真实 describe；每次真实 execute 都让子进程退出，触发宿主崩溃限额。
    writeFileSync(
      entry,
      `${original}\nprocess.prependListener('message', message => { if (message?.t === 'req' && message.method === 'execute') process.exit(42) })\n`,
    )
    expect((await request.put(endpoint, { data: { enabled: true } })).ok()).toBe(true)
    await newProject(page)
    await addNode(page, '大声说')
    const node = (await elements(page)).find((element) => element.nodeType === 'acme/shout')!
    await page
      .getByTestId('generator')
      .getByRole('textbox', { name: '提示词', exact: true })
      .fill('crash recovery')
    const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
    await openCanvasSettings(page)
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: /^插件/ }).click()
    const row = settings.locator('[data-plugin="acme/echo"]')
    await expect(row).toContainText('已加载')
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request.post(`/api/canvases/${canvas}/nodes/${node.id}/run`, {
        data: {},
      })
      expect(response.status()).toBe(202)
      const { runId } = await response.json()
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const run = window.__plein.engine.doc.get(id)!.run as { id: string; status: string }
            return { id: run?.id, status: run?.status }
          }, node.id),
        )
        .toEqual({ id: runId, status: 'failed' })
    }
    await expect
      .poll(
        async () =>
          (await (await request.get('/api/plugins/local')).json()).find(
            (plugin: { id: string }) => plugin.id === 'acme/echo',
          ).status,
      )
      .toBe('error')
    // 面板一直打开，不用重新扫描或切换窗口帮助刷新。
    await expect(row).toContainText('出错')
    await expect(row.getByRole('alert')).toContainText('插件反复崩溃')
    await page.setViewportSize({ width: 800, height: 560 })
    await expect(row.getByRole('alert')).toBeInViewport()
    await settings.screenshot({
      path: test.info().outputPath('plugin-crashed.png'),
      animations: 'disabled',
    })
    writeFileSync(entry, original)
    await row.getByRole('button', { name: '重新加载', exact: true }).click()
    await expect(row).toContainText('已加载')
    await expect(row.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 900 })
    await clickElement(page, node.id)
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    await expect(
      page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true }),
    ).toHaveValue('crash recovery')
    await page.getByTestId('generator').getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, node.id)
    await expect(page.getByText('CRASH RECOVERY!', { exact: true })).toBeVisible()
    expect(
      (await elements(page))
        .filter((element) => element.nodeType === 'acme/shout')
        .map((element) => element.id),
    ).toEqual([node.id])
  } finally {
    writeFileSync(entry, original)
    await request.put(endpoint, { data: { enabled: false } })
  }
})
