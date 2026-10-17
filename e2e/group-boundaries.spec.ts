import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, newProject, waitEngine } from './canvas'

type GroupEngine = Window['__plein']['engine'] & {
  groupSelection(): void
  ungroupSelection(): void
  nudge(dx: number, dy: number): void
  undo(): void
  doc: Window['__plein']['engine']['doc'] & { flush(): void; undo: { stopCapturing(): void } }
}

for (const change of ['move', 'ungroup', 'lock'] as const) {
  test(`拖动子节点时同伴 ${change} 父分组，旧预览不能覆盖最新世界位置`, async ({
    page,
    context,
  }) => {
    const ids = await setup(page, true)
    const frame = await page.evaluate(
      () => [...window.__plein.engine.doc.elements()].find((el) => el.kind === 'frame')!.id,
    )
    const original = await snapshot(page)
    const peerContext = await context.browser()!.newContext()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      const peer = await peerContext.newPage()
      peer.on('pageerror', (error) => errors.push(error.message))
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      await clickElement(page, ids.first)
      const at = await centerOf(page, ids.first)
      await page.mouse.move(at.x, at.y)
      await page.mouse.down()
      await page.mouse.move(at.x + 60, at.y - 45, { steps: 4 })
      await peer.getByRole('treeitem', { name: '折叠 分组 定位到画布', exact: true }).click()
      if (change === 'move') {
        const p = await peer.evaluate((id) => {
          const { engine } = window.__plein
          const r = engine.doc.worldRect(id)
          return engine.worldToClient(r.x + 80, r.y + 16)
        }, frame)
        await peer.mouse.move(p.x, p.y)
        await peer.mouse.down()
        await peer.mouse.move(p.x + 80, p.y - 40, { steps: 5 })
        await peer.mouse.up()
      } else if (change === 'ungroup') await peer.keyboard.press('ControlOrMeta+Shift+g')
      else
        await peer.evaluate((id) => {
          const doc = window.__plein.engine.doc as unknown as {
            origin: unknown
            ydoc: { transact(fn: () => void, origin: unknown): void }
            mutable(id: string): { set(key: string, value: boolean): void }
          }
          doc.ydoc.transact(() => doc.mutable(id).set('locked', true), doc.origin)
        }, frame)
      const latest = await snapshot(peer)
      await expect.poll(() => snapshot(page)).toEqual(latest)
      const child = latest.find((el) => el.id === ids.first)!
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              (
                window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }
              ).scene.rect(id),
            ids.first,
          ),
        )
        .toEqual(child.rect)
      await expect(page.getByText('节点或连线已更新，本次操作已取消', { exact: true })).toHaveCount(
        1,
      )
      await page.mouse.move(at.x + 100, at.y - 60)
      await page.mouse.up()
      expect(await snapshot(page)).toEqual(latest)
      expect(await snapshot(peer)).toEqual(latest)
      if (change === 'lock') {
        await expect(page.getByTitle('已锁定', { exact: true })).toHaveCount(1)
      } else {
        await peer.getByRole('button', { name: '撤销', exact: true }).click()
        await expect.poll(() => snapshot(peer)).toEqual(original)
        await expect.poll(() => snapshot(page)).toEqual(original)
      }
      expect(errors).toEqual([])
    } finally {
      await peerContext.close()
    }
  })
}
async function setup(page: Page, grouped: boolean) {
  await newProject(page)
  return page.evaluate((grouped) => {
    const first = window.__plein.addNode({
      type: 'plein/text',
      name: '分组子一',
      params: { text: '保留正文' },
      x: 400,
      y: 200,
    })
    const second = window.__plein.addNode({
      type: 'plein/text',
      name: '分组子二',
      params: {},
      x: 800,
      y: 200,
    })
    const engine = window.__plein.engine as GroupEngine
    engine.selection.set([first, second])
    if (grouped) engine.groupSelection()
    engine.doc.flush()
    engine.doc.undo.stopCapturing()
    engine.zoomToFit()
    return { first, second }
  }, grouped)
}
const snapshot = (page: Page) =>
  page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .map((el) => ({
        id: el.id,
        kind: el.kind,
        parent: el.parentId,
        rect: window.__plein.engine.doc.worldRect(el.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )

for (const command of ['group', 'ungroup'] as const) {
  for (const order of ['before', 'after'] as const) {
    test(`${command} 与紧邻的 ${order} 位置修改分别撤销，不连带回退`, async ({ page }) => {
      await setup(page, command === 'ungroup')
      const expected = await page.evaluate(
        ({ command, order }) => {
          const engine = window.__plein.engine as GroupEngine
          const read = () =>
            [...engine.doc.elements()]
              .map((el) => ({
                id: el.id,
                kind: el.kind,
                parent: el.parentId,
                rect: engine.doc.worldRect(el.id),
              }))
              .sort((a, b) => a.id.localeCompare(b.id))
          const act = () =>
            command === 'group' ? engine.groupSelection() : engine.ungroupSelection()
          if (order === 'before') {
            engine.nudge(17, 9)
            const expected = read()
            act()
            engine.undo()
            return expected
          }
          act()
          const expected = read()
          engine.nudge(21, -12)
          engine.undo()
          return expected
        },
        { command, order },
      )
      expect(await snapshot(page)).toEqual(expected)
    })
  }
}
