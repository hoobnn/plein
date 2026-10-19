import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, elements, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-seconds-collaboration-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=96x64:d=2:r=8',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'shot.webm'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function fixture(page: Page) {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(join(dir, 'shot.webm'))
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
    .toBe(1)
  const video = (await elements(page)).find((e) => e.kind === 'video')!
  const id = await page.evaluate((source) => {
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '秒数并发校验',
      x: 3000,
      y: 1000,
      params: { subtitles: false, clips: [{ source, in: 0, out: 1.8 }] },
    })
    window.__plein.connect([source, 'video'], [id, 'clips'])
    return id
  }, video.id)
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const input = editor.getByRole('spinbutton', { name: '入点（秒）', exact: true })
  await expect(input).toHaveValue('0')
  const saved = () =>
    page.evaluate(
      (id) =>
        (
          window.__plein.engine.doc.get(id)!.params!.clips as Array<{ in: number; out?: number }>
        )[0]!,
      id,
    )
  return { id, editor, input, saved }
}

for (const kind of ['conflict', 'other-field', 'cross-in', 'cross-out'] as const) {
  test(`视频秒数同任务更新后失焦 ${kind} 保留最新剪辑并按当前边界校验`, async ({ page }) => {
    const f = await fixture(page)
    const field =
      kind === 'cross-out'
        ? f.editor.getByRole('spinbutton', { name: '出点（秒）', exact: true })
        : f.input
    await field.fill(kind === 'cross-out' ? '0.8' : '0.4')
    await field.evaluate(
      (input: HTMLInputElement, { id, kind }) => {
        const doc = window.__plein.engine.doc
        const clips = doc.get(id)!.params!.clips as Array<Record<string, unknown>>
        const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
        const patch =
          kind === 'conflict'
            ? { in: 0.2, out: 1.4 }
            : kind === 'other-field'
              ? { out: 1.4 }
              : kind === 'cross-in'
                ? { out: 0.2 }
                : { in: 1 }
        params.set(
          'clips',
          clips.map((clip) => ({ ...clip, ...patch })),
        )
        input.blur()
      },
      { id: f.id, kind },
    )
    if (kind === 'conflict') {
      expect(await f.saved()).toMatchObject({ in: 0.2, out: 1.4 })
      await expect(f.input).toHaveValue('0.4')
      await f.editor.getByRole('button', { name: '保留当前数值', exact: true }).click()
      expect(await f.saved()).toMatchObject({ in: 0.4, out: 1.4 })
    } else if (kind === 'other-field') {
      expect(await f.saved()).toMatchObject({ in: 0.4, out: 1.4 })
    } else {
      expect(await f.saved()).toMatchObject(
        kind === 'cross-in' ? { in: 0, out: 0.2 } : { in: 1, out: 1.8 },
      )
      await expect(f.editor.getByRole('alert')).toContainText(
        kind === 'cross-in' ? '入点需要早于出点' : '出点需要晚于入点',
      )
    }
  })
}
