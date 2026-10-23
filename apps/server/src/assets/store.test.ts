import { readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { openDb } from '../storage/db'
import { tempDir } from '../testing'
import * as media from './media'
import { AssetStore } from './store'

afterEach(() => vi.restoreAllMocks())

describe('资产入库资源清理', () => {
  it('衍生物写入失败保留原件和已完成的衍生物，删除未完成文件', async () => {
    const dir = tempDir('plein-store-')
    const db = openDb(dir)
    const store = new AssetStore(dir, db, 16 * 1024 * 1024)
    await store.init()
    const original = media.imageThumb
    vi.spyOn(media, 'imageThumb').mockImplementation(async (src, out, size) => {
      if (size === 256) return original(src, out, size)
      await writeFile(out, 'partial thumbnail')
      throw new Error('disk full')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const bytes = await sharp({
        create: { width: 16, height: 16, channels: 3, background: '#123456' },
      })
        .png()
        .toBuffer()
      const asset = await store.ingest('local', Readable.from([bytes]), {
        mime: 'image/png',
        name: 'sample.png',
      })
      expect(asset.variants).toEqual(['thumb-256'])
      expect(await store.readOriginal('local', asset.id)).toEqual(new Uint8Array(bytes))
      expect((await readdir(dirname(store.originalPath(asset.id)))).sort()).toEqual(
        [asset.id, `${asset.id}.thumb-256.webp`].sort(),
      )
    } finally {
      db.$client.close()
    }
  })
})
