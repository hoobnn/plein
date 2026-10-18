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

for (const nested of [false, true]) {
  for (const reverse of [false, true]) {
    test(`批量解组 ${nested ? '嵌套' : '同级'} 分组，${reverse ? '逆序' : '正序'} 选取可一步撤销重做`, async ({
      page,
    }) => {
      const ids = await setup(page, true)
      const prepared = await page.evaluate(
        ({ ids, nested, reverse }) => {
          const engine = window.__plein.engine as GroupEngine
          const firstFrame = [...engine.doc.elements()].find((el) => el.kind === 'frame')!.id
          const third = window.__plein.addNode({
            type: 'plein/text',
            name: '第三个节点',
            params: { text: '不能丢失' },
            x: 1400,
            y: 300,
          })
          engine.selection.set(nested ? [firstFrame, third] : [third])
          engine.groupSelection()
          engine.doc.flush()
          const frames = [...engine.doc.elements()]
            .filter((el) => el.kind === 'frame')
            .map((el) => el.id)
          engine.selection.set(reverse ? frames.reverse() : frames)
          engine.doc.undo.stopCapturing()
          ;(engine.doc.undo as unknown as { captureTimeout: number }).captureTimeout = 0
          return [ids.first, ids.second, third]
        },
        { ids, nested, reverse },
      )
      const original = await snapshot(page)
      await page.keyboard.press('ControlOrMeta+Shift+g')
      await expect
        .poll(async () => (await snapshot(page)).filter((el) => el.kind === 'frame'))
        .toEqual([])
      const ungrouped = await snapshot(page)
      expect(ungrouped.map((el) => el.id).sort()).toEqual([...prepared].sort())
      for (const el of ungrouped)
        expect(el.rect).toEqual(original.find((before) => before.id === el.id)!.rect)
      await expect
        .poll(() => page.evaluate(() => window.__plein.engine.selection.values().sort()))
        .toEqual([...prepared].sort())
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(() => snapshot(page)).toEqual(original)
      await page.getByRole('button', { name: '重做', exact: true }).click()
      await expect.poll(() => snapshot(page)).toEqual(ungrouped)
    })
  }
}

test('分组右键菜单可发现解组入口，执行后可撤销恢复', async ({ page }) => {
  await setup(page, true)
  const original = await snapshot(page)
  const point = await page.evaluate(() => {
    const { engine } = window.__plein
    const frame = [...engine.doc.elements()].find((el) => el.kind === 'frame')!
    const r = engine.doc.worldRect(frame.id)
    return engine.worldToClient(r.x + 80, r.y + 16)
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const action = page.getByRole('menuitem', { name: /^解组/ })
  await expect(action).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'test-results/group-context-menu.png' })
  await action.click()
  await expect
    .poll(async () => (await snapshot(page)).filter((el) => el.kind === 'frame'))
    .toEqual([])
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values().length))
    .toBe(2)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => snapshot(page)).toEqual(original)
})

test('快速连续复制嵌套分组，每次复制可独立撤销且内部层级保持完整', async ({ page }) => {
  const ids = await setup(page, true)
  const original = await page.evaluate((source) => {
    const engine = window.__plein.engine as GroupEngine
    const inner = [...engine.doc.elements()].find((el) => el.kind === 'frame')!.id
    const third = window.__plein.addNode({
      type: 'plein/image',
      name: '外层子节点',
      params: { model: 'plein/mock:image' },
      x: 1400,
      y: 300,
    })
    if (!window.__plein.connect([source, 'text'], [third, 'prompt']))
      throw new Error('connect failed')
    engine.selection.set([inner, third])
    engine.groupSelection()
    engine.doc.flush()
    return [...engine.doc.elements()].length
  }, ids.first)
  const first = await page.evaluate(() => {
    const engine = window.__plein.engine as GroupEngine & { duplicateSelection(): void }
    engine.duplicateSelection()
    const first = engine.selection.values()[0]!
    engine.duplicateSelection()
    return first
  })
  await expect.poll(async () => (await snapshot(page)).length).toBe(original * 3)
  const copied = await snapshot(page)
  const inspect = () =>
    page.evaluate(() => {
      const { engine } = window.__plein
      const elements = [...engine.doc.elements()]
      const roots = elements.filter((el) => el.parentId === null)
      const rootOf = (id: string): string => {
        const parent = engine.doc.get(id)?.parentId
        return parent ? rootOf(parent) : id
      }
      return {
        roots: roots.map((root) => ({
          rect: engine.doc.worldRect(root.id),
          direct: elements
            .filter((el) => el.parentId === root.id)
            .map((el) => el.kind)
            .sort(),
          nested: elements.filter((el) => el.id !== root.id && rootOf(el.id) === root.id).length,
          edges: [...engine.doc.edges()].filter(
            (edge) => rootOf(edge.from[0]) === root.id && rootOf(edge.to[0]) === root.id,
          ).length,
        })),
        edges: [...engine.doc.edges()].length,
      }
    })
  const structure = await inspect()
  expect(structure.edges).toBe(3)
  expect(structure.roots).toHaveLength(3)
  for (const root of structure.roots) {
    expect(root.direct).toEqual(['frame', 'node'])
    expect(root.nested).toBe(4)
    expect(root.edges).toBe(1)
  }
  const positions = structure.roots.map((root) => root.rect.x).sort((a, b) => a - b)
  expect(positions).toEqual([positions[0], positions[0]! + 24, positions[0]! + 48])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).length).toBe(original * 2)
  expect((await snapshot(page)).some((el) => el.id === first)).toBe(true)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).length).toBe(original * 3)
  expect(await snapshot(page)).toEqual(copied)
  expect(await inspect()).toEqual(structure)
  const top = await page.evaluate(() => {
    const { engine } = window.__plein
    const texts = [...engine.doc.elements()].filter((el) => el.name === '分组子一')
    const top = texts.sort(
      (a, b) => engine.doc.worldRect(b.id).x - engine.doc.worldRect(a.id).x,
    )[0]!.id
    engine.zoomToFit()
    return top
  })
  await clickElement(page, top)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([top])
  await page.screenshot({ path: test.info().outputPath('nested-copy-hit.png') })
})
