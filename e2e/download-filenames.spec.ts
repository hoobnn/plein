import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import { sineWav, solidPng } from '../packages/providers/src/mock/media'
import { newProject, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
for (const [kind, name, expected, mime] of [
  ['image', '分镜.v2', '分镜.v2.png', 'image/png'],
  ['image', '角色.PNG', '角色.PNG', 'image/png'],
  ['audio', '台词.final', '台词.final.wav', 'audio/wav'],
  ['video', '成片.v1.2', '成片.v1.2.mp4', 'video/mp4'],
] as const) {
  test(`${kind} 下载标题 ${name} 使用实际格式扩展名并保持原文件`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const bytes =
      kind === 'image'
        ? Buffer.from(solidPng(64, 48, [100, 140, 180]))
        : kind === 'audio'
          ? Buffer.from(sineWav(0.2, 440))
          : execFileSync('ffmpeg', [
              '-hide_banner',
              '-loglevel',
              'error',
              '-f',
              'lavfi',
              '-i',
              'color=c=teal:s=64x48:r=10:d=0.3',
              '-c:v',
              'libx264',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              'frag_keyframe+empty_moov',
              '-f',
              'mp4',
              'pipe:1',
            ])
    const upload = await page.request.post('/api/assets', {
      headers: { 'content-type': mime },
      data: bytes,
    })
    expect(upload.status()).toBe(201)
    const assetId = (await upload.json()).id as string
    const id = await page.evaluate(
      ({ assetId, kind, name }) => {
        const engine = window.__plein.engine as unknown as Engine
        let id: string
        if (kind === 'audio') {
          id = window.__plein.addNode({ type: 'plein/speech', name, params: {}, x: 400, y: 300 })
          engine.doc.mutable(id)!.set('results', [
            {
              id: 'audio-candidate',
              runId: 'fixture',
              port: 'audio',
              at: 1,
              value: { type: 'audio', assetId },
            },
          ])
          engine.doc.mutable(id)!.set('adopted', 'audio-candidate')
        } else {
          engine.paste({
            plein: 1,
            edges: [],
            elements: [
              {
                id: 'source',
                kind,
                name,
                assetId,
                x: 400,
                y: 300,
                w: 240,
                h: 180,
                z: 'a0',
                rotation: 0,
                locked: false,
                parentId: null,
              },
            ],
          })
          id = [...engine.doc.elements()][0]!.id
        }
        engine.selection.set([id])
        engine.doc.flush()
        return id
      },
      { assetId, kind, name },
    )
    await zoomTo(page, [id])
    const scope =
      kind === 'audio'
        ? page.getByTestId('generator')
        : page.getByRole('toolbar', { name: '结果操作', exact: true })
    const event = page.waitForEvent('download')
    await scope.getByRole('button', { name: '下载', exact: true }).click()
    const download = await event
    expect(await download.failure()).toBeNull()
    expect(download.suggestedFilename()).toBe(expected)
    expect(readFileSync((await download.path())!)).toEqual(bytes)
    await expect(scope.getByRole('button', { name: '下载', exact: true })).toBeEnabled()
    expect(errors).toEqual([])
  })
}

for (const [name, declaredMime, expected] of [
  ['历史.PNG', 'image/png', '历史.PNG'],
  ['历史.v2', 'image/jpeg', '历史.v2.png'],
] as const) {
  test(`历史下载 ${name} 不重复扩展名且以原文件格式为准`, async ({ page }) => {
    await newProject(page)
    const bytes = Buffer.from(solidPng(64, 48, [140, 100, 180]))
    const upload = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png' },
      data: bytes,
    })
    expect(upload.status()).toBe(201)
    const assetId = (await upload.json()).id as string
    await page.evaluate(
      ({ assetId, name, declaredMime }) => {
        const id = window.__plein.addNode({ type: 'plein/image', name, params: {}, x: 400, y: 300 })
        const engine = window.__plein.engine as unknown as Engine
        engine.doc.mutable(id)!.set('results', [
          {
            id: 'historical-candidate',
            runId: 'fixture',
            port: 'images',
            at: 1,
            value: { type: 'image', assetId, mime: declaredMime },
          },
        ])
        engine.doc.mutable(id)!.set('adopted', 'historical-candidate')
        engine.doc.flush()
      },
      { assetId, name, declaredMime },
    )
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '生成历史', exact: true })
    await panel.getByRole('checkbox', { name: `选择「${name}」`, exact: true }).check()
    const event = page.waitForEvent('download')
    await panel.getByRole('button', { name: '下载', exact: true }).click()
    const download = await event
    expect(await download.failure()).toBeNull()
    expect(download.suggestedFilename()).toBe(expected)
    expect(readFileSync((await download.path())!)).toEqual(bytes)
  })
}
