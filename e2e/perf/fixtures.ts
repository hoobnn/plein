import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Engine } from '../../packages/canvas-core/src/engine'
import type { ClipboardData } from '../../packages/doc/src/clipboard'
import type { CanvasElement, Edge } from '../../packages/doc/src/types'
import { sineWav, solidPng } from '../../packages/providers/src/mock/media'
import { waitEngine } from './probe'
import { canonical } from './report'

export const MEDIA_FIXTURE_VERSION = 2

export interface MediaFixture {
  version: number
  elements: number
  imageAssets: number
  videoAssets: number
  audioAssets: number
  serializedBytes: number
  contentHash: string
  data: ClipboardData
}

export function fixtureContentHash(data: unknown): string {
  return createHash('sha256').update(canonical(data)).digest('hex')
}

/** Hash the actual demo graph without random identifiers or transient run status. */
export function demoContentHash(data: { elements: CanvasElement[]; edges: Edge[] }): string {
  return fixtureContentHash(normalizeDemoFixture(data))
}

/** 演示便签宽度、行结构相同；用实际量高统一几何，避免初始视口的异步量高竞态。 */
export async function fitDemoMarkdown(page: Page) {
  await page.evaluate(() => {
    const { engine } = (window as unknown as { __plein: { engine: Engine } }).__plein
    const markdown = [...engine.doc.elements()].filter((el) => el.kind === 'markdown')
    if (!markdown.length) return
    if (markdown.some((el) => el.w !== 240 || !/^# 镜头 \d+\n画面描述$/.test(el.text ?? '')))
      throw new Error('Demo markdown fixture no longer has uniform width and line structure')
    const heights = new Set(
      [...document.querySelectorAll<HTMLElement>('[data-markdown-id]')].map(
        (node) => engine.scene.get(node.dataset.markdownId!)!.h,
      ),
    )
    if (heights.size !== 1) throw new Error('Demo markdown layout has not settled')
    const [height] = heights
    engine.doc.ydoc.transact(() => {
      for (const el of markdown) engine.doc.mutable(el.id)!.set('h', height)
    })
    engine.doc.undo.clear()
  })
}

export function normalizeDemoFixture(data: { elements: CanvasElement[]; edges: Edge[] }) {
  const ids = new Map(data.elements.map((el, index) => [el.id, `element-${index}`]))
  const remap = (id: string) => {
    const normalized = ids.get(id)
    if (!normalized) throw new Error(`Demo fixture references a missing element: ${id}`)
    return normalized
  }
  return {
    // 便签高度由应用自身的正文排版量出（fitDemoMarkdown 已校验同轮一致），属于被测结果而非夹具输入；
    // 计入哈希会让任何字号、行高调整都使基线与候选无法比较。
    elements: data.elements.map(({ id, parentId, run: _run, ...el }) => {
      const { h, ...rest } = el
      return {
        ...(el.kind === 'markdown' ? rest : { ...rest, h }),
        id: remap(id),
        parentId: parentId === null ? null : remap(parentId),
      }
    }),
    edges: data.edges
      .map(({ id: _id, from, to, ...edge }) => ({
        ...edge,
        from: [remap(from[0]), from[1]],
        to: [remap(to[0]), to[1]],
      }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b))),
  }
}

interface FixtureAsset {
  id: string
  kind: 'image' | 'video' | 'audio'
  variants: string[]
}

/** Local deterministic files are ingested through the real API; no model or external URL is used. */
export async function createMediaFixture(
  base: string,
  options: { elements?: number; imageAssets?: number; video?: boolean; audio?: boolean } = {},
): Promise<MediaFixture> {
  const count = options.elements ?? 1000
  const imageCount = options.imageAssets ?? 32
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(imageCount) ||
    imageCount < 1
  )
    throw new Error('Fixture element and asset counts must be positive integers')
  const upload = async (body: Uint8Array, mime: string, name: string) => {
    const response = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(name) },
      body: Buffer.from(body),
    })
    if (!response.ok) throw new Error(`Fixture upload failed: ${name} (${response.status})`)
    const asset = (await response.json()) as FixtureAsset
    const variants =
      asset.kind === 'image'
        ? ['thumb-256', 'thumb-1024']
        : [asset.kind === 'video' ? 'poster' : 'waveform']
    if (
      !/^[a-f0-9]{64}$/.test(asset.id) ||
      variants.some((variant) => !asset.variants.includes(variant))
    )
      throw new Error(`Fixture derivatives are missing: ${name}`)
    return asset
  }
  const images: FixtureAsset[] = []
  for (let i = 0; i < imageCount; i++) {
    const color = Math.imul(i + 1, 0x9e3779) & 0xffffff
    images.push(
      await upload(
        solidPng(1024, 768, [(color >>> 16) & 255, (color >>> 8) & 255, color & 255]),
        'image/png',
        `media-fixture-${i}.png`,
      ),
    )
  }
  let video: FixtureAsset | undefined
  if (options.video !== false) {
    const dir = mkdtempSync(join(tmpdir(), 'plein-perf-media-'))
    try {
      const file = join(dir, 'fixture.webm')
      execFileSync(process.env.PERF_FFMPEG ?? 'ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=160x90:d=1:r=8',
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-map_metadata',
        '-1',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-pix_fmt',
        'yuv420p',
        file,
      ])
      video = await upload(readFileSync(file), 'video/webm', 'media-fixture.webm')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const audio =
    options.audio === false ? undefined : await upload(sineWav(1), 'audio/wav', 'media-fixture.wav')
  const columns = Math.ceil(Math.sqrt(count * 1.6))
  const elements: CanvasElement[] = Array.from({ length: count }, (_, i) => {
    const asset =
      i % 20 === 18 && video ? video : i % 20 === 19 && audio ? audio : images[i % images.length]!
    return {
      id: `fixture-${i}`,
      kind: asset.kind,
      assetId: asset.id,
      name: `真实媒体 ${i}`,
      x: (i % columns) * 320,
      y: Math.floor(i / columns) * 240,
      w: 240,
      h: asset.kind === 'audio' ? 96 : asset.kind === 'video' ? 135 : 180,
      rotation: 0,
      parentId: null,
      locked: false,
      z: 'a0',
    }
  })
  const data: ClipboardData = { plein: 1, elements, edges: [] }
  return {
    version: MEDIA_FIXTURE_VERSION,
    elements: count,
    imageAssets: imageCount,
    videoAssets: video ? 1 : 0,
    audioAssets: audio ? 1 : 0,
    serializedBytes: Buffer.byteLength(JSON.stringify(data)),
    contentHash: fixtureContentHash(data),
    data,
  }
}

export async function seedMediaCanvas(page: Page, base: string, fixture: MediaFixture) {
  const response = await fetch(`${base}/api/canvases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Media performance fixture' }),
  })
  if (!response.ok) throw new Error(`Fixture canvas creation failed: ${response.status}`)
  const { id } = (await response.json()) as { id: string }
  await page.goto(`${base}/#/c/${id}`)
  await waitEngine(page)
  await page.evaluate((data) => {
    const engine = (
      window as unknown as {
        __plein: {
          engine: { paste(data: unknown): void; zoomToFit(): void; selection: { clear(): void } }
        }
      }
    ).__plein.engine
    engine.paste(data)
    engine.selection.clear()
    engine.zoomToFit()
  }, fixture.data)
  await page.waitForFunction((count) => {
    const engine = (
      window as unknown as { __plein?: { engine: { doc: { elements(): Iterable<unknown> } } } }
    ).__plein?.engine
    return engine && [...engine.doc.elements()].length === count
  }, fixture.elements)
  return id
}
