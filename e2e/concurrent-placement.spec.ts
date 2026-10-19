import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject, waitNode, zoomTo } from './canvas'
import { solidPng } from '../packages/providers/src/mock/media'

for (const size of ['160x90', '90x160']) {
  test(`两份 ${size} 续镜在同一批画布通知前完成，卡片不重叠且各自连接正确素材`, async ({
    page,
  }) => {
    await newProject(page)
    const assets: string[] = []
    for (const color of ['teal', 'orange']) {
      const bytes = execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=${size}:d=0.6:r=10`,
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ])
      const response = await page.request.post('/api/assets', {
        headers: { 'Content-Type': 'video/mp4' },
        data: bytes,
      })
      expect(response.status()).toBe(201)
      assets.push((await response.json()).id)
    }
    const sources = await page.evaluate(
      ({ assets, portrait }) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          paste(data: unknown): void
        }
        engine.paste({
          plein: 1,
          edges: [],
          elements: assets.map((assetId, i) => ({
            id: `source-${i}`,
            kind: 'video',
            name: i ? '续镜乙' : '续镜甲',
            assetId,
            x: 300,
            y: 200 + i * (portrait ? 300 : 200),
            w: portrait ? 135 : 240,
            h: portrait ? 240 : 135,
            rotation: 0,
            locked: false,
            parentId: null,
          })),
        })
        return [...engine.doc.elements()].map((el) => el.id)
      },
      { assets, portrait: size === '90x160' },
    )
    await zoomTo(page, sources)
    const slots: { ready: boolean; release(): void }[] = []
    await page.route('**/api/media/derive', async (route) => {
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const slot = { ready: false, release }
      slots.push(slot)
      const response = await route.fetch()
      slot.ready = true
      await waiting
      await route.fulfill({ response }).catch(() => {})
    })
    const nodes = () =>
      page.evaluate(() =>
        [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/video'),
      )
    try {
      for (const [index, name] of ['续镜甲', '续镜乙'].entries()) {
        await page.getByRole('treeitem', { name: `${name} 定位到画布`, exact: true }).click()
        await page.getByRole('button', { name: '续镜', exact: true }).click()
        await page
          .getByRole('dialog', { name: '续镜', exact: true })
          .getByRole('button', { name: /从尾帧续/ })
          .click()
        await expect.poll(() => slots[index]?.ready).toBe(true)
      }
      await page.evaluate(() => {
        const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
          flush(): void
          schedule(flush: () => void): void
          restorePlacementTest?(): void
        }
        doc.flush()
        const schedule = doc.schedule
        doc.schedule = () => {}
        doc.restorePlacementTest = () => {
          doc.schedule = schedule
          doc.flush()
          delete doc.restorePlacementTest
        }
      })
      slots[0]!.release()
      await expect.poll(async () => (await nodes()).length).toBe(1)
      const first = (await nodes())[0]!
      expect(
        await page.evaluate(
          (id) =>
            (window.__plein.engine as unknown as { scene: { has(id: string): boolean } }).scene.has(
              id,
            ),
          first.id,
        ),
      ).toBe(false)
      slots[1]!.release()
      await expect.poll(async () => (await nodes()).length).toBe(2)
      await page.evaluate(() =>
        (
          window.__plein.engine.doc as unknown as { restorePlacementTest?(): void }
        ).restorePlacementTest?.(),
      )
      const all = await page.evaluate(() =>
        [...window.__plein.engine.doc.elements()].map((el) => ({
          id: el.id,
          kind: el.kind,
          name: el.name,
          rect: window.__plein.engine.doc.worldRect(el.id),
        })),
      )
      await zoomTo(
        page,
        all.map((el) => el.id),
      )
      // 展示卡片和连线本身，清掉选区以免浮动编辑器盖住重叠区域。
      await page.evaluate(() => window.__plein.engine.selection.set([]))
      await expect(page.getByTestId('generator')).toHaveCount(0)
      await page.screenshot({
        path: test.info().outputPath('concurrent-continued.png'),
        animations: 'disabled',
      })
      const collisions: string[] = []
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]!,
            b = all[j]!,
            r = a.rect,
            s = b.rect
          if (r.x < s.x + s.w && r.x + r.w > s.x && r.y < s.y + s.h && r.y + r.h > s.y)
            collisions.push(`${a.name} / ${b.name}`)
        }
      expect(collisions).toEqual([])
      const graph = await page.evaluate(() => ({
        elements: [...window.__plein.engine.doc.elements()],
        edges: [...window.__plein.engine.doc.edges()],
      }))
      const frames: string[] = []
      for (const next of await nodes()) {
        expect(next.params?.aspectRatio).toBe(size === '90x160' ? '9:16' : '16:9')
        const from = next.params!.continuesFrom as {
          elementId: string
          assetId: string
          frameAssetId: string
        }
        const source = graph.elements.find((el) => el.id === from.elementId)!
        expect(sources).toContain(source.id)
        expect(from.assetId).toBe(source.assetId)
        const input = graph.edges.filter((edge) => edge.to[0] === next.id)
        expect(input).toHaveLength(1)
        const frame = graph.elements.find((el) => el.id === input[0]!.from[0])!
        expect(frame.assetId).toBe(from.frameAssetId)
        expect(frame.name).toContain(source.name)
        frames.push(frame.id)
      }
      expect(new Set(frames).size).toBe(2)
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await nodes()).length).toBe(1)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(4)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()].length)).toBe(1)
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect.poll(async () => (await nodes()).length).toBe(2)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toEqual(graph.edges)
      const restored = await page.evaluate(() =>
        [...window.__plein.engine.doc.elements()].map((el) => ({
          id: el.id,
          kind: el.kind,
          name: el.name,
          rect: window.__plein.engine.doc.worldRect(el.id),
        })),
      )
      expect(restored.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        all.sort((a, b) => a.id.localeCompare(b.id)),
      )
    } finally {
      for (const slot of slots) slot.release()
      await page.evaluate(() =>
        (
          window.__plein.engine.doc as unknown as { restorePlacementTest?(): void }
        ).restorePlacementTest?.(),
      )
    }
  })
}

test('从同一参考图连续套用预设，最终横屏尺寸避让并用正确参考图实际生成', async ({ page }) => {
  await newProject(page)
  const response = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(solidPng(180, 320, [30, 140, 180])),
  })
  expect(response.status()).toBe(201)
  const asset = (await response.json()).id as string
  const source = await page.evaluate((asset) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(data: unknown): void
    }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'source',
          kind: 'image',
          assetId: asset,
          name: '参考角色',
          x: 300,
          y: 200,
          w: 180,
          h: 320,
          rotation: 0,
          locked: false,
          parentId: null,
        },
      ],
    })
    return [...engine.doc.elements()][0]!.id
  }, asset)
  await zoomTo(page, [source])
  for (const preset of ['角色三视图', '多机位九宫格']) {
    await page.getByRole('treeitem', { name: '参考角色 定位到画布', exact: true }).click()
    await page
      .getByRole('toolbar', { name: '结果操作', exact: true })
      .getByRole('button', { name: '预设', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: '预设', exact: true })
      .getByRole('button', { name: new RegExp(`^${preset}`) })
      .click()
    await expect(
      page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true }),
    ).toBeFocused()
  }
  const graph = await page.evaluate(() => ({
    elements: [...window.__plein.engine.doc.elements()],
    edges: [...window.__plein.engine.doc.edges()],
  }))
  const nodes = graph.elements.filter((el) => el.nodeType === 'plein/image')
  expect(nodes).toHaveLength(2)
  const rects = await page.evaluate(
    (ids) => ids.map((id) => window.__plein.engine.doc.worldRect(id)),
    nodes.map((el) => el.id),
  )
  expect(rects[0]!.x).toBe(rects[1]!.x)
  for (const [i, node] of nodes.entries()) {
    expect(node.params?.aspectRatio).toBe('16:9')
    expect(rects[i]!.w).toBeGreaterThan(rects[i]!.h)
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: [source, 'image'], to: [node.id, 'references'] }),
    )
  }
  const a = rects[0]!,
    b = rects[1]!
  expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
  await page.getByRole('treeitem', { name: '角色三视图 定位到画布', exact: true }).click()
  const first = nodes.find((el) => el.name === '角色三视图')!
  const generator = page.getByTestId('generator')
  await generator
    .getByRole('textbox', { name: '提示词', exact: true })
    .fill('基于参考角色生成正面、侧面和背面三视图')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, first.id)
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
  const input = await (
    await page.request.get(`/api/canvases/${canvas}/nodes/${first.id}/input`)
  ).json()
  expect(input.inputs.references).toEqual([
    expect.objectContaining({ type: 'image', assetId: asset }),
  ])
})
