import { expect, test, type Page } from '@playwright/test'
import { clickElement, deselect, elements, handleOf, newProject, waitNode, zoomTo } from './canvas'

const rects = (page: Page, ids: string[]) =>
  page.evaluate((ids) => ids.map((id) => window.__plein.engine.doc.worldRect(id)), ids)
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

for (const reverse of [false, true]) {
  test(`视频连接${reverse ? '反向' : '正向'}拖线优先主视频，不误连尾帧`, async ({ page }) => {
    await newProject(page)
    const ids = await page.evaluate((reverse) => {
      const ids = [0, 700].map((x, i) =>
        window.__plein.addNode({ type: 'plein/video', name: `视频${i}`, params: {}, x, y: 0 }),
      )
      if (reverse) {
        const extra = window.__plein.addNode({
          type: 'plein/video',
          name: '已有下游',
          params: {},
          x: 700,
          y: 700,
        })
        window.__plein.connect([ids[0]!, 'video'], [extra, 'videos'])
      }
      return ids
    }, reverse)
    await page.waitForFunction(
      (id) =>
        (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(
          id,
        ),
      ids[0]!,
    )
    await zoomTo(page, ids)
    const out = await handleOf(page, ids[0]!, 'out')
    const input = await handleOf(page, ids[1]!, 'in')
    const [from, to] = reverse ? [input, out] : [out, input]
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            [...window.__plein.engine.doc.edges()]
              .filter((edge) => edge.to[0] === id)
              .map((edge) => [edge.from[1], edge.to[1]]),
          ids[1]!,
        ),
      )
      .toEqual([['video', 'videos']])
  })
}

for (const kind of ['image', 'video']) {
  test(`从${kind}拉线新建视频自动采用对应生成模式，连接确实被使用`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(
      (kind) =>
        window.__plein.addNode({ type: `plein/${kind}`, name: '来源', params: {}, x: 0, y: 0 }),
      kind,
    )
    await page.waitForFunction(
      (id) =>
        (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(
          id,
        ),
      id,
    )
    await zoomTo(page, [id])
    const from = await handleOf(page, id, 'out')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 160, from.y, { steps: 12 })
    await page.mouse.up()
    await page.getByRole('textbox', { name: '搜索节点', exact: true }).fill('生成视频')
    await page.keyboard.press('Enter')
    const target = (await elements(page)).find(
      (el) => el.nodeType === 'plein/video' && el.id !== id,
    )!
    expect(target).toBeDefined()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.mode, target.id),
    ).toBe(kind === 'image' ? 'image' : 'reference')
    expect(
      await page.evaluate(
        (id) =>
          [...window.__plein.engine.doc.edges()]
            .filter((edge) => edge.to[0] === id)
            .map((edge) => [edge.from[1], edge.to[1]]),
        target.id,
      ),
    ).toEqual([[kind === 'image' ? 'images' : 'video', kind === 'image' ? 'images' : 'videos']])
  })
}

test('连续从工具栏添加卡片自动避让，整理、撤销后连接保持完整', async ({ page }) => {
  await newProject(page)
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '添加节点', exact: true }).click()
    await page.getByPlaceholder('添加节点').fill('LLM')
    await page.keyboard.press('Enter')
  }
  const ids = (await elements(page)).filter((el) => el.kind === 'node').map((el) => el.id)
  expect(ids).toHaveLength(3)
  const before = await rects(page, ids)
  for (let i = 0; i < before.length; i++)
    for (const r of before.slice(i + 1)) expect(overlaps(before[i]!, r)).toBe(false)
  expect(
    await page.evaluate(
      (ids) => [
        window.__plein.connect([ids[0]!, 'text'], [ids[1]!, 'prompt']),
        window.__plein.connect([ids[1]!, 'text'], [ids[2]!, 'prompt']),
      ],
      ids,
    ),
  ).toEqual([true, true])
  const links = await page.evaluate(() => [...window.__plein.engine.doc.edges()])
  await deselect(page)
  await page.getByRole('button', { name: '整理画布', exact: true }).click()
  const after = await rects(page, ids)
  expect(after[1]!.x).toBeGreaterThan(after[0]!.x + after[0]!.w)
  expect(after[2]!.x).toBeGreaterThan(after[1]!.x + after[1]!.w)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await rects(page, ids)).toEqual(before)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual(links)
})

test('Frame 内新增卡片避让到框外后使用正确父级，不留下框外的幽灵子元素', async ({ page }) => {
  await newProject(page)
  for (const name of ['Frame', 'LLM', 'LLM']) {
    await page.getByRole('button', { name: '添加节点', exact: true }).click()
    await page.getByPlaceholder('添加节点').fill(name)
    await page.keyboard.press('Enter')
  }
  const all = await elements(page)
  const frame = all.find((el) => el.kind === 'frame')!
  const nodes = all.filter((el) => el.nodeType === 'plein/llm')
  expect(nodes).toHaveLength(2)
  expect(nodes[0]!.parentId).toBe(frame.id)
  expect(nodes[1]!.parentId).toBeNull()
  const geometry = await rects(
    page,
    nodes.map((el) => el.id),
  )
  expect(overlaps(geometry[0]!, geometry[1]!)).toBe(false)
})

test('派生视频的节点和连线一步撤销重做，不遗留空节点或断线', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '派生来源',
      params: { model: 'plein/mock:image', prompt: '派生图' },
      x: 0,
      y: 0,
    }),
  )
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  expect(
    (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, id)
  await clickElement(page, id)
  await page.getByTestId('generator').getByRole('button', { name: '生成视频', exact: true }).click()
  const video = (await elements(page)).find((el) => el.nodeType === 'plein/video')!
  const geometry = await rects(page, [id, video.id])
  expect(overlaps(geometry[0]!, geometry[1]!)).toBe(false)
  const links = await page.evaluate(() => [...window.__plein.engine.doc.edges()])
  expect(links).toHaveLength(1)
  await deselect(page)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await elements(page)).some((el) => el.id === video.id)).toBe(false)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual([])
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await elements(page)).some((el) => el.id === video.id)).toBe(true)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual(links)
  expect(await rects(page, [id, video.id])).toEqual(geometry)
})

test('整理按新位置适配全部卡片，分量纵向展开后不把节点留在屏幕外', async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const ids = Array.from({ length: 6 }, (_, i) =>
      window.__plein.addNode({
        type: 'plein/llm',
        name: `分量卡片${i}`,
        params: {},
        x: 400,
        y: 300,
      }),
    )
    for (let i = 0; i < ids.length; i += 2)
      window.__plein.connect([ids[i]!, 'text'], [ids[i + 1]!, 'prompt'])
    return ids
  })
  await page.waitForFunction(
    (id) =>
      (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(id),
    ids[0]!,
  )
  await page.getByRole('button', { name: '整理画布', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate((ids) => {
        const engine = window.__plein.engine
        return ids.every((id) => {
          const r = engine.doc.worldRect(id)
          const a = engine.worldToClient(r.x, r.y)
          const b = engine.worldToClient(r.x + r.w, r.y + r.h)
          return a.x >= 0 && a.y >= 0 && b.x <= innerWidth && b.y <= innerHeight
        })
      }, ids),
    )
    .toBe(true)
})

test('连线落到重叠卡片时只接可见的上层卡片，不吸到被盖住的端口', async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const add = window.__plein.addNode
    return {
      source: add({
        type: 'plein/text',
        name: '文本来源',
        params: { text: '参考文案' },
        x: -700,
        y: 0,
      }),
      hidden: add({ type: 'plein/llm', name: '下层目标', params: {}, x: 0, y: 0 }),
      visible: add({ type: 'plein/image', name: '上层目标', params: {}, x: -80, y: 0 }),
    }
  })
  await page.waitForFunction(
    (id) =>
      (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(id),
    ids.source,
  )
  await clickElement(page, ids.source)
  await expect(page.getByTestId('generator')).toBeVisible()
  await zoomTo(page, Object.values(ids))
  const points = await page.evaluate((ids) => {
    const e = window.__plein.engine
    const a = e.doc.worldRect(ids.source)
    const b = e.doc.worldRect(ids.hidden)
    return {
      from: e.worldToClient(a.x + a.w, a.y + a.h / 2),
      to: e.worldToClient(b.x, b.y + b.h / 2),
    }
  }, ids)
  await page.mouse.move(points.from.x, points.from.y)
  await page.mouse.down()
  await page.mouse.move(points.to.x, points.to.y, { steps: 16 })
  await page.mouse.up()
  await expect
    .poll(() =>
      page.evaluate(() => [...window.__plein.engine.doc.edges()].map((edge) => edge.to[0])),
    )
    .toEqual([ids.visible])
})
