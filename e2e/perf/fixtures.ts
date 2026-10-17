import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ClipboardData } from '../../packages/doc/src/clipboard'
import type { CanvasElement } from '../../packages/doc/src/types'
import { sineWav, solidPng } from '../../packages/providers/src/mock/media'
import { waitEngine } from './probe'

export const MEDIA_FIXTURE_VERSION = 2

export interface MediaFixture {
  version: number
  elements: number
  imageAssets: number
  videoAssets: number
  audioAssets: number
  serializedBytes: number
  data: ClipboardData
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
