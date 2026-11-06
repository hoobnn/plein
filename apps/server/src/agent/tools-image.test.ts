import { EditMask } from '@plein/nodes'
import {
  connect,
  createElement,
  gridPlan,
  groupShots,
  shotGroupOf,
  updateElement,
} from '@plein/doc'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas } from '../testing'
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

describe('create_mask', () => {
  const pixels = async (f: Awaited<ReturnType<typeof fixture>>, assetId: string) => {
    const { data, info } = await sharp(f.server.assets.originalPath(assetId))
      .raw()
      .toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels]!
    return { at, info, values: new Set(data) }
  }
  const setup = async (w = 40, h = 30) => {
    const f = await fixture()
    const src = await f.importImage(await gradient(w, h), `s${w}.png`)
    const image = createElement(f.doc, {
      kind: 'image',
      assetId: src.id,
      x: 0,
      y: 0,
      w: 100,
      h: 75,
    })
    const node = addNode(f.doc, 'plein/image-edit', { x: 300, y: 0 })
    connect(f.doc, [image, 'image'], [node, 'image'])
    return { ...f, src, image, node }
  }

  it('矩形蒙版：与原图同宽高的黑底白区二值 PNG，写进局部重绘节点的 mask 参数', async () => {
    const f = await setup()
    const out = (await f.invoke('create_mask', {
      element_id: f.node,
      rects: [{ x: 10, y: 5, w: 10, h: 10 }],
    })) as { mask_asset_id: string; applied: boolean }
    expect(out.applied).toBe(true)
    const px = await pixels(f, out.mask_asset_id)
    expect([px.info.width, px.info.height]).toEqual([40, 30])
    expect([...px.values].sort((a, b) => a - b)).toEqual([0, 255])
    expect(px.at(12, 8)).toBe(255)
    expect(px.at(9, 8)).toBe(0)
    expect(px.at(20, 8)).toBe(0)
    expect(px.at(12, 4)).toBe(0)
    const mask = f.doc.get(f.node)!.params!.mask
    expect(EditMask.parse(mask)).toEqual({
      assetId: out.mask_asset_id,
      width: 40,
      height: 30,
      sourceAssetId: f.src.id,
    })
  })

  it('多边形、比例坐标与 feather 外扩', async () => {
    const f = await setup()
    const tri = (await f.invoke('create_mask', {
      element_id: f.image,
      polygons: [
        [
          [0, 0],
          [30, 0],
          [0, 30],
        ],
      ],
    })) as { mask_asset_id: string; applied: boolean }
    expect(tri.applied).toBe(false)
    const t = await pixels(f, tri.mask_asset_id)
    expect(t.at(5, 5)).toBe(255)
    expect(t.at(28, 28)).toBe(0)
    expect(t.at(35, 2)).toBe(0)

    const norm = (await f.invoke('create_mask', {
      element_id: f.image,
      normalized: true,
      rects: [{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
    })) as { mask_asset_id: string }
    const n = await pixels(f, norm.mask_asset_id)
    expect([n.at(25, 20), n.at(10, 10)]).toEqual([255, 0])

    const grown = (await f.invoke('create_mask', {
      element_id: f.image,
      rects: [{ x: 15, y: 10, w: 10, h: 10 }],
      feather: 4,
    })) as { mask_asset_id: string }
    const g = await pixels(f, grown.mask_asset_id)
    expect([g.at(12, 14), g.at(10, 14), g.at(26, 14), g.at(29, 14)]).toEqual([255, 0, 255, 0])
  })

  it('外部蒙版：按原图尺寸缩放并二值化；宽高比不一致被拒', async () => {
    const f = await setup()
    // 灰度 100 的一半区域 + 白色另一半，缩小一倍的版本
    const ext = await sharp({
      create: { width: 20, height: 15, channels: 3, background: { r: 100, g: 100, b: 100 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 10, height: 15, channels: 3, background: '#fff' },
          })
            .png()
            .toBuffer(),
          left: 10,
          top: 0,
        },
      ])
      .png()
      .toBuffer()
    const asset = await f.importImage(ext, 'ext-mask.png')
    const out = (await f.invoke('create_mask', {
      element_id: f.node,
      mask_asset_id: asset.id,
    })) as { mask_asset_id: string; applied: boolean; width: number }
    const px = await pixels(f, out.mask_asset_id)
    expect([px.info.width, px.info.height]).toEqual([40, 30])
    expect([...px.values].sort((a, b) => a - b)).toEqual([0, 255])
    expect([px.at(5, 5), px.at(35, 5)]).toEqual([0, 255])
    expect(f.doc.get(f.node)!.params!.mask).toMatchObject({ width: 40, height: 30 })

    const wrong = await f.importImage(
      await sharp({ create: { width: 30, height: 30, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
      'sq.png',
    )
    await expect(
      f.invoke('create_mask', { element_id: f.node, mask_asset_id: wrong.id }),
    ).rejects.toThrow('宽高比不一致')
  })

  it('拒绝：没圈出区域、两类输入并存、节点没连原图、非图片元素', async () => {
    const f = await setup()
    await expect(
      f.invoke('create_mask', { element_id: f.node, rects: [{ x: 500, y: 500, w: 5, h: 5 }] }),
    ).rejects.toThrow('没有圈出任何区域')
    await expect(f.invoke('create_mask', { element_id: f.node })).rejects.toThrow(
      '必须且只能给一类',
    )
    await expect(
      f.invoke('create_mask', {
        element_id: f.node,
        rects: [{ x: 0, y: 0, w: 5, h: 5 }],
        mask_asset_id: f.src.id,
      }),
    ).rejects.toThrow('必须且只能给一类')
    const bare = addNode(f.doc, 'plein/image-edit', { x: 0, y: 400 })
    await expect(
      f.invoke('create_mask', { element_id: bare, rects: [{ x: 0, y: 0, w: 5, h: 5 }] }),
    ).rejects.toThrow('还没有连入原图')
    const note = createElement(f.doc, { kind: 'markdown', text: 'x', x: 0, y: 0, w: 10, h: 10 })
    await expect(
      f.invoke('create_mask', { element_id: note, rects: [{ x: 0, y: 0, w: 5, h: 5 }] }),
    ).rejects.toThrow('不是图片')
    const other = addNode(f.doc, 'plein/text', { x: 0, y: 600 })
    await expect(
      f.invoke('create_mask', { element_id: other, rects: [{ x: 0, y: 0, w: 5, h: 5 }] }),
    ).rejects.toThrow('有蒙版')
  })
})
