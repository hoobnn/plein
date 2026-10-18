import { expect, test, type Locator, type Page } from '@playwright/test'
import { clickElement, deselect, newProject, waitNode, zoomTo } from './canvas'

async function hiddenMakesNoDifference(
  page: Page,
  overlay: Locator,
  clip: { x: number; y: number; width: number; height: number },
) {
  const before = await page.screenshot({ clip, animations: 'disabled' })
  await overlay.evaluate((el) => {
    el.style.visibility = 'hidden'
  })
  const after = await page.screenshot({ clip, animations: 'disabled' })
  await overlay.evaluate((el) => {
    el.style.visibility = ''
  })
  return before.equals(after)
}

test('被上层节点覆盖的分镜角标不会穿透，并随拖动恢复', async ({ page }) => {
  await newProject(page)
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png' },
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAYklEQVR4nO3PUQkAIBTAwBfFqDbXEH4cwmABbnP2+rrhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACx67GbZ1HuLZqnQAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  expect(uploaded.status()).toBe(201)
  const asset = (await uploaded.json()).id as string
  const ids = await page.evaluate((asset) => {
    const e = window.__plein.engine as unknown as {
      paste(data: unknown): void
      doc: { elements(): Iterable<{ id: string; name?: string }> }
      selection: { set(ids: string[]): void }
    }
    const base = { rotation: 0, locked: false, parentId: null, x: 0, y: 0, w: 400, h: 400 }
    e.paste({
      plein: 1,
      elements: [
        {
          ...base,
          id: 'frame',
          kind: 'frame',
          name: '分镜角标组',
          params: { shotGroup: { order: ['shot'] } },
        },
        {
          ...base,
          id: 'shot',
          kind: 'image',
          name: '被挡的镜头',
          parentId: 'frame',
          x: 40,
          y: 40,
          w: 200,
          h: 200,
          assetId: asset,
        },
      ],
      edges: [],
    })
    const all = [...e.doc.elements()]
    const shot = all.find((el) => el.name === '被挡的镜头')!.id
    const cover = window.__plein.addNode({
      type: 'plein/text',
      name: '上层遮挡卡片',
      params: { text: '' },
      x: 40 + 24,
      y: 40 + 24,
    })
    e.selection.set([])
    return { shot, cover }
  }, asset)
  await page.waitForFunction(
    (id) =>
      (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(id),
    ids.cover,
  )
  await zoomTo(page, Object.values(ids))
  const badge = page.locator(`[data-shot-badge="${ids.shot}"]`)
  await expect(badge).toBeAttached()
  const box = (await badge.boundingBox())!
  expect(
    await hiddenMakesNoDifference(page, badge, box),
    '上层卡片覆盖镜头时，角标也应被遮挡',
  ).toBe(true)
  await page.evaluate((id) => {
    const m = window.__plein.engine.doc.mutable(id) as unknown as {
      set(k: string, v: number): void
    }
    m.set('x', 600)
  }, ids.cover)
  await expect.poll(() => badge.evaluate((el) => el.style.clipPath)).toBe('')
  expect(await hiddenMakesNoDifference(page, badge, box)).toBe(false)
})

test('画布内播放器全屏时不保留节点的遮挡裁剪，退出后恢复', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/video',
      name: '全屏裁剪回归',
      params: { model: 'plein/mock:video', prompt: '测试播放器', duration: 2 },
      x: 0,
      y: 0,
    }),
  )
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
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
  await deselect(page)
  const at = await page.evaluate((id) => {
    const e = window.__plein.engine
    const r = e.doc.worldRect(id)
    return e.worldToClient(r.x + r.w / 2, r.y + r.h / 2)
  }, id)
  await page.mouse.dblclick(at.x, at.y)
  const player = page.locator('.plein-player')
  await expect(player).toBeVisible()
  await page.evaluate((id) => {
    const r = window.__plein.engine.doc.worldRect(id)
    const cover = window.__plein.addNode({
      type: 'plein/text',
      name: '局部覆盖播放器',
      params: { text: '' },
      x: r.x,
      y: r.y + r.h - 52,
    })
    const m = window.__plein.engine.doc.mutable(cover) as unknown as {
      set(k: string, v: number): void
    }
    m.set('w', 60)
    m.set('h', 52)
  }, id)
  await expect.poll(() => player.evaluate((el) => el.style.clipPath)).not.toBe('')
  const play = player.locator('.plein-player-btn').first()
  await expect.poll(() => play.evaluate((el: HTMLElement) => el.inert)).toBe(true)
  await player.getByRole('button', { name: '全屏', exact: true }).click()
  await expect(player).toHaveClass(/is-fullscreen/)
  await expect.poll(() => play.evaluate((el: HTMLElement) => el.inert)).toBe(false)
  await expect.poll(() => player.evaluate((el) => getComputedStyle(el).clipPath)).toBe('none')
  await player.getByRole('button', { name: '退出全屏', exact: true }).click()
  await expect.poll(() => player.evaluate((el) => getComputedStyle(el).clipPath)).not.toBe('none')
  await expect.poll(() => play.evaluate((el: HTMLElement) => el.inert)).toBe(true)
})

test('窗口缩窄后生成器同步变窄，操作区不被窗口和侧栏裁掉', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '窗口适配',
      params: { text: '可编辑内容' },
      x: 0,
      y: 0,
    }),
  )
  await page.waitForFunction(
    (id) =>
      (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(id),
    id,
  )
  await clickElement(page, id)
  await expect(page.getByTestId('generator')).toBeVisible()
  await page.setViewportSize({ width: 800, height: 900 })
  await expect
    .poll(
      async () => {
        const box = (await page.getByTestId('generator').boundingBox())!
        return Math.round(box.x + box.width)
      },
      { timeout: 3000 },
    )
    .toBeLessThanOrEqual(788)
})

test('创作引导不会盖住所选节点的生成器和按钮', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '引导的分镜',
      params: { shots: [] },
      x: -700,
      y: 0,
    })
    return window.__plein.addNode({
      type: 'plein/image',
      name: '被编辑的镜头图',
      params: {},
      x: 0,
      y: 0,
    })
  })
  await page.waitForFunction(
    (id) =>
      (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(id),
    id,
  )
  await clickElement(page, id)
  await expect(page.getByTestId('creation-guide')).toBeVisible()
  await page.evaluate(() =>
    (
      window.__plein.engine as unknown as { camera: { panBy(x: number, y: number): void } }
    ).camera.panBy(0, -250),
  )
  await expect
    .poll(
      async () => {
        const box = (await page.getByTestId('generator').boundingBox())!
        const guide = (await page.getByTestId('creation-guide').boundingBox())!
        const left = Math.max(box.x, guide.x)
        const top = Math.max(box.y, guide.y)
        const right = Math.min(box.x + box.width, guide.x + guide.width)
        const bottom = Math.min(box.y + box.height, guide.y + guide.height)
        if (right - left < 8 || bottom - top < 8) return true
        return page.evaluate(
          ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="generator"]'),
          { x: (left + right) / 2, y: (top + bottom) / 2 },
        )
      },
      { timeout: 3000 },
    )
    .toBe(true)
  const reference = page
    .getByTestId('generator')
    .getByRole('button', { name: '参考图', exact: true })
  await expect(reference).toBeVisible()
  expect(
    await reference.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    }),
  ).toBe(true)
})

for (const grouped of [false, true]) {
  test(`新建样片${grouped ? '从分组内分镜' : '从普通分镜'}按世界坐标避让已有节点`, async ({
    page,
  }) => {
    await newProject(page)
    const ids = await page.evaluate((grouped) => {
      const e = window.__plein.engine
      const board = window.__plein.addNode({
        type: 'plein/storyboard',
        name: '自动放置分镜',
        params: { shots: [{ id: 's1', no: 1, duration: 2, description: '放置回归' }] },
        x: 0,
        y: 0,
      })
      if (grouped) {
        const engine = e as unknown as {
          paste(data: unknown): void
          selection: { values(): string[] }
        }
        engine.paste({
          plein: 1,
          elements: [
            {
              id: 'frame',
              kind: 'frame',
              name: '分镜容器',
              parentId: null,
              x: 1000,
              y: 1000,
              w: 600,
              h: 700,
              rotation: 0,
              locked: false,
            },
          ],
          edges: [],
        })
        const m = e.doc.mutable(board) as unknown as { set(k: string, v: unknown): void }
        m.set('parentId', engine.selection.values()[0])
        m.set('x', 40)
        m.set('y', 60)
      }
      const r = e.doc.worldRect(board)
      const blocker = window.__plein.addNode({
        type: 'plein/text',
        name: '原有剧本卡片',
        params: { text: '不可覆盖' },
        x: r.x + r.w + 80,
        y: r.y,
      })
      return { board, blocker }
    }, grouped)
    await page.waitForFunction(
      (id) =>
        (window.__plein.engine as unknown as { scene: { rect(id: string): unknown } }).scene.rect(
          id,
        ),
      ids.board,
    )
    await clickElement(page, ids.board)
    await page
      .getByTestId('generator')
      .getByRole('button', { name: /^编辑分镜表/ })
      .click()
    await page.getByRole('button', { name: '节奏样片', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '序列', exact: true })).toBeVisible()
    const geometry = await page.evaluate(({ board, blocker }) => {
      const doc = window.__plein.engine.doc
      const draft = [...doc.elements()].find((el) => el.nodeType === 'plein/animatic')!
      return {
        board: doc.worldRect(board),
        blocker: doc.worldRect(blocker),
        draft: doc.worldRect(draft.id),
      }
    }, ids)
    expect(geometry.draft.x).toBeGreaterThanOrEqual(geometry.board.x + geometry.board.w + 80)
    const a = geometry.draft,
      b = geometry.blocker
    expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
  })
}
