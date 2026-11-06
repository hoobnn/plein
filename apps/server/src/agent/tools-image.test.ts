import { createElement, gridPlan, groupShots, shotGroupOf, updateElement } from '@plein/doc'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, createCanvas } from '../testing'
import { serverCapabilities, serverContext, type ToolEnv } from './tools'

async function fixture() {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const env: ToolEnv = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    canvasApi: server.canvasApi,
  }
  const invoke = (name: string, args: unknown) =>
    serverCapabilities.invoke(name, serverContext(env), args)
  const importImage = async (png: Buffer, name = 'src.png') => {
    return server.assets.ingest('local', Readable.from([png]), { mime: 'image/png', name })
  }
  return { server, id, doc, env, invoke, importImage }
}

/** 每个像素颜色唯一（r=x、g=y），能逐像素核对切出来的区域 */
async function gradient(w: number, h: number) {
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      raw[i] = x * 10
      raw[i + 1] = y * 10
      raw[i + 2] = 7
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer()
}

describe('split_grid', () => {
  it('切片边界与浏览器端一致：5×3 切 2×2 得 2×1、3×1、2×2、3×2，像素逐一对应', async () => {
    const f = await fixture()
    const src = await f.importImage(await gradient(5, 3))
    const el = createElement(f.doc, {
      kind: 'image',
      assetId: src.id,
      x: 0,
      y: 0,
      w: 320,
      h: 192,
    })
    const out = (await f.invoke('split_grid', { element_id: el, rows: 2, cols: 2 })) as {
      frame_id: string
      element_ids: string[]
      asset_ids: string[]
    }
    // 与 apps/web/src/canvas/grid.test.ts 里 drawImage 的参数是同一组边界
    const plan = gridPlan(5, 3, 2, 2)
    expect(plan.tiles.map((t) => [t.left, t.top, t.width, t.height])).toEqual([
      [0, 0, 2, 1],
      [2, 0, 3, 1],
      [0, 1, 2, 2],
      [2, 1, 3, 2],
    ])
    for (const [i, t] of plan.tiles.entries()) {
      const meta = f.server.assets.get('local', out.asset_ids[i]!)!
      expect([meta.width, meta.height]).toEqual([t.width, t.height])
      const { data } = await sharp(f.server.assets.originalPath(meta.id))
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect([data[0], data[1]]).toEqual([t.left * 10, t.top * 10])
    }
    expect(groupShots(f.doc, out.frame_id).map((e) => e.assetId)).toEqual(out.asset_ids)
    expect(shotGroupOf(f.doc.get(out.frame_id)!)?.source).toEqual({
      elementId: el,
      rows: 2,
      cols: 2,
    })
    expect(f.doc.get(out.frame_id)!.x).toBeGreaterThanOrEqual(320)
  })

  it('按 EXIF 方向展开后再切（与浏览器解码一致）', async () => {
    const f = await fixture()
    // 6×4 存储、方向 6（顺时针 90°）：展开后是 4×6
    const png = await sharp({ create: { width: 6, height: 4, channels: 3, background: '#fff' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
    const src = await f.server.assets.ingest('local', Readable.from([png]), {
      mime: 'image/jpeg',
      name: 'o.jpg',
    })
    const el = createElement(f.doc, { kind: 'image', assetId: src.id, x: 0, y: 0, w: 100, h: 150 })
    const out = (await f.invoke('split_grid', { element_id: el, rows: 3, cols: 1 })) as {
      asset_ids: string[]
    }
    const sizes = out.asset_ids.map((id) => {
      const m = f.server.assets.get('local', id)!
      return [m.width, m.height]
    })
    expect(sizes).toEqual([
      [4, 2],
      [4, 2],
      [4, 2],
    ])
  })

  it('图片太小、没有图片、锁定的元素都明确拒绝', async () => {
    const f = await fixture()
    const small = await f.importImage(await gradient(2, 2), 'small.png')
    const el = createElement(f.doc, { kind: 'image', assetId: small.id, x: 0, y: 0, w: 10, h: 10 })
    await expect(f.invoke('split_grid', { element_id: el, rows: 3, cols: 3 })).rejects.toThrow(
      '无法切成 3×3',
    )
    const note = createElement(f.doc, { kind: 'markdown', text: 'x', x: 0, y: 0, w: 10, h: 10 })
    await expect(f.invoke('split_grid', { element_id: note, rows: 2, cols: 2 })).rejects.toThrow(
      '没有图片',
    )
    await expect(f.invoke('split_grid', { element_id: el, rows: 1, cols: 1 })).rejects.toThrow(
      '大于 1',
    )
    const big = await f.importImage(await gradient(8, 8), 'big.png')
    const locked = createElement(f.doc, {
      kind: 'image',
      assetId: big.id,
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      locked: true,
    })
    await expect(f.invoke('split_grid', { element_id: locked, rows: 2, cols: 2 })).rejects.toThrow(
      '锁定',
    )
  })

  it('切图期间来源图片被换掉则不写入画布', async () => {
    const f = await fixture()
    const a = await f.importImage(await gradient(8, 8), 'a.png')
    const b = await f.importImage(await gradient(9, 9), 'b.png')
    const el = createElement(f.doc, { kind: 'image', assetId: a.id, x: 0, y: 0, w: 10, h: 10 })
    // 第一片入库时把来源换成另一张图，模拟切图期间用户改了画布
    const assets = f.server.assets
    const original = assets.ingest.bind(assets)
    let swapped = false
    assets.ingest = ((...args: Parameters<typeof original>) => {
      if (!swapped) {
        swapped = true
        updateElement(f.doc, el, { assetId: b.id })
      }
      return original(...args)
    }) as typeof assets.ingest
    await expect(f.invoke('split_grid', { element_id: el, rows: 2, cols: 2 })).rejects.toThrow(
      '已变化',
    )
    assets.ingest = original
  })
})
