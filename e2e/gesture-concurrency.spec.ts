import { expect, test } from './fixtures'
import { centerOf, clickElement, newProject, waitEngine } from './canvas'

test('同伴移动中止旧拖动预览，松手和重载保留已同步的位置 @core', async ({ page, context }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '协作拖动',
      params: { text: '保留正文' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
    await clickElement(peer, id)
    const start = await centerOf(page, id)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 70, start.y - 60, { steps: 4 })
    const at = await centerOf(peer, id)
    await peer.mouse.move(at.x, at.y)
    await peer.mouse.down()
    await peer.mouse.move(at.x + 120, at.y - 40, { steps: 4 })
    await peer.mouse.up()
    const latest = await peer.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
    const geometry = () =>
      page.evaluate((id) => {
        const engine = window.__plein
          .engine as unknown as import('../packages/canvas-core/src/engine').Engine
        return { saved: engine.doc.worldRect(id), shown: engine.scene.rect(id) }
      }, id)
    await expect.poll(geometry).toEqual({ saved: latest, shown: latest })
    await expect(
      page.getByRole('status').filter({ hasText: '节点或连线已更新，本次操作已取消' }),
    ).toHaveCount(1)
    await page.mouse.move(start.x + 100, start.y - 90)
    await page.mouse.up()
    expect(await geometry()).toEqual({ saved: latest, shown: latest })
    await page.reload()
    await waitEngine(page)
    await expect.poll(geometry).toEqual({ saved: latest, shown: latest })
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id)).toBe(
      '保留正文',
    )
  } finally {
    await peerContext.close()
  }
})
