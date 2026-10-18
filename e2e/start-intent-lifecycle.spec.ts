import { expect, test } from '@playwright/test'
import { elements, newProject, settle, waitEngine } from './canvas'

for (const template of [false, true]) {
  test(`${template ? '短剧模板' : '快速开始'}确认迟到时目标画布已经打开，仍插入一次且撤销后不自动重插`, async ({
    page,
  }) => {
    await newProject(page)
    const original = new URL(page.url()).hash
    if (template)
      await page.request.put('/api/providers/plein/mock/config', { data: { enabled: false } })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let result: { lastCanvasId: string } | undefined
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      result = await response.json()
      await held
      await route.fulfill({ response })
    })
    try {
      await page.goto('/')
      if (template) {
        const dialog = page.getByRole('dialog', { name: '欢迎使用 Plein', exact: true })
        await dialog.getByRole('button', { name: '跳过', exact: true }).click()
        await dialog.getByRole('button', { name: /从短剧模板开始/ }).click()
        await expect.poll(() => !!result).toBe(true)
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      } else {
        await page.getByRole('button', { name: /剧本创作/ }).click()
        await expect.poll(() => !!result).toBe(true)
      }
      // 项目已经在服务端创建，可从其他入口先打开；浏览器的创建应答仍未返回。
      await page.evaluate((id) => {
        location.hash = `/c/${id}`
      }, result!.lastCanvasId)
      await waitEngine(page)
      expect(await elements(page)).toHaveLength(0)
      release()
      const nodeType = template ? 'plein/storyboard' : 'plein/llm'
      await expect
        .poll(async () => (await elements(page)).filter((el) => el.nodeType === nodeType).length)
        .toBe(1)
      await settle(page, (await elements(page))[0]!.id)
      expect(
        await page.evaluate(() => {
          const { engine } = window.__plein
          const { insets } = (
            engine as unknown as {
              camera: { insets: { left: number; right: number; top: number; bottom: number } }
            }
          ).camera
          return [...engine.doc.elements()]
            .filter((el) => !el.parentId)
            .every((el) => {
              const r = engine.doc.worldRect(el.id)
              const a = engine.worldToClient(r.x, r.y)
              const b = engine.worldToClient(r.x + r.w, r.y + r.h)
              return (
                a.x >= insets.left &&
                a.y >= insets.top &&
                b.x <= innerWidth - insets.right &&
                b.y <= innerHeight - insets.bottom
              )
            })
        }),
      ).toBe(true)
      expect(new URL(page.url()).hash).toBe(`#/c/${result!.lastCanvasId}`)
      const count = (await elements(page)).length
      await page.keyboard.press('Escape')
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await elements(page)).length).toBe(0)
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect.poll(async () => (await elements(page)).length).toBe(count)
      await settle(page, (await elements(page))[0]!.id)
      await page.screenshot({
        path: test.info().outputPath('late-start-inserted.png'),
        animations: 'disabled',
      })
      await page.evaluate((hash) => {
        location.hash = hash
      }, original)
      await waitEngine(page)
      expect(await elements(page)).toHaveLength(0)
      await page.evaluate((id) => {
        location.hash = `/c/${id}`
      }, result!.lastCanvasId)
      await waitEngine(page)
      await expect.poll(async () => (await elements(page)).length).toBe(count)
    } finally {
      release()
      if (template)
        await page.request.put('/api/providers/plein/mock/config', { data: { enabled: true } })
    }
  })
}
