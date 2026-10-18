import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-animatic-refresh-'))
  for (const color of ['blue', 'orange'])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=64x64`,
      '-frames:v',
      '1',
      join(dir, `${color}.png`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function board(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '样片刷新来源',
      x: 300,
      y: 200,
      params: {
        shots: [
          { id: 'one', no: 1, duration: 3 },
          { id: 'two', no: 2, duration: 2 },
        ],
      },
    }),
  )
  const open = async () => {
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toBeVisible()
  }
  await open()
  return { id, open }
}

async function fixture(page: Page) {
  const f = await board(page)
  const assets: string[] = []
  for (const color of ['blue', 'orange']) {
    const uploaded = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': `${color}.png` },
      data: readFileSync(join(dir, `${color}.png`)),
    })
    expect(uploaded.status()).toBe(201)
    assets.push((await uploaded.json()).id)
  }
  const image = await page.evaluate(
    ({ id, assetId }) => {
      const image = window.__plein.addNode({
        type: 'plein/image',
        name: '已有分镜图',
        x: 900,
        y: 200,
        params: { source: { storyboard: id, shot: 'one', role: 'image' } },
      })
      const node = window.__plein.engine.doc.mutable(image)! as unknown as {
        set(key: string, value: unknown): void
      }
      node.set('results', [
        { id: 'old', runId: 'old', port: 'image', at: 1, value: { type: 'image', assetId } },
      ])
      node.set('adopted', 'old')
      return image
    },
    { id: f.id, assetId: assets[0] },
  )
  const submissions: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url()))
      submissions.push(request.url())
  })
  await page.getByRole('button', { name: '节奏样片', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toBeVisible()
  const id = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/animatic')!.id,
  )
  for (const [name, value] of [
    ['样片镜头时长（秒）', '7'],
    ['对白起始延迟（秒）', '0.5'],
    ['对白句间停顿（秒）', '0.8'],
  ]) {
    const input = editor.getByRole('spinbutton', { name, exact: true })
    await input.fill(value!)
    await input.blur()
  }
  const read = () => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params, id)
  const update = () =>
    page.evaluate(
      ({ image, assetId }) => {
        const node = window.__plein.engine.doc.mutable(image)! as unknown as {
          set(key: string, value: unknown): void
        }
        node.set('results', [
          { id: 'new', runId: 'new', port: 'image', at: 2, value: { type: 'image', assetId } },
        ])
        node.set('adopted', 'new')
      },
      { image, assetId: assets[1] },
    )
  return { ...f, boardId: f.id, id, editor, read, update, assets, submissions }
}

for (const change of ['missing', 'type', 'readonly'] as const) {
  test(`样片刷新遇到 ${change} 保留旧快照和节奏，来源恢复后可更新`, async ({ page }) => {
    const f = await fixture(page)
    const before = await f.read()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(
      ({ boardId, change }) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          deleteSelection(): void
          doc: {
            readOnly: boolean
            undo: { stopCapturing(): void }
            origin: unknown
            ydoc: { transact(fn: () => void, origin: unknown): void }
          }
        }
        if (change === 'readonly') engine.doc.readOnly = true
        else {
          engine.doc.undo.stopCapturing()
          if (change === 'missing') {
            engine.selection.set([boardId])
            engine.deleteSelection()
          } else
            engine.doc.ydoc.transact(
              () =>
                (
                  engine.doc.mutable(boardId)! as unknown as {
                    set(key: string, value: unknown): void
                  }
                ).set('nodeType', 'plein/text'),
              engine.doc.origin,
            )
          engine.doc.undo.stopCapturing()
        }
      },
      { boardId: f.boardId, change },
    )
    await f.editor.getByRole('button', { name: '更新已有素材', exact: true }).click()
    expect(await f.read()).toEqual(before)
    expect(errors).toEqual([])
    await expect(f.editor.getByRole('alert')).toContainText(
      change === 'readonly' ? '只读' : '来源分镜',
    )
    await f.editor.screenshot({
      path: test.info().outputPath(`${change}-refresh-refused.png`),
      animations: 'disabled',
    })
    await page.evaluate((change) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        undo(): void
        doc: { readOnly: boolean }
      }
      if (change === 'readonly') engine.doc.readOnly = false
      else engine.undo()
    }, change)
    await f.update()
    await f.editor.getByRole('button', { name: '更新已有素材', exact: true }).click()
    await expect(f.editor.getByRole('alert')).toHaveCount(0)
    const after = await f.read()
    expect((after!.shots as Array<Record<string, unknown>>)[0]).toMatchObject({
      duration: 7,
      lineDelay: 0.5,
      lineGap: 0.8,
      imageAssetId: f.assets[1],
    })
    expect((after!.shots as unknown[]).length).toBe(2)
    expect(f.submissions).toEqual([])
    await expect(f.editor.locator('.seq-clip').first().locator('img')).toHaveAttribute(
      'src',
      new RegExp(f.assets[1]!),
    )
    await expect
      .poll(() =>
        f.editor
          .locator('.seq-clip')
          .first()
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
  })
}

test('刷新样片独立撤销并保留同帧改名，重做恢复新素材及原节奏', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.read()
  await f.update()
  await f.editor
    .getByRole('button', { name: '更新已有素材', exact: true })
    .evaluate((button, id) => {
      const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        origin: unknown
        ydoc: { transact(fn: () => void, origin: unknown): void }
        undo: { stopCapturing(): void }
      }
      doc.undo.stopCapturing()
      doc.ydoc.transact(
        () =>
          (doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
            'name',
            '刷新前改名',
          ),
        doc.origin,
      )
      ;(button as HTMLButtonElement).click()
    }, f.id)
  const after = await f.read()
  expect((after!.shots as Array<Record<string, unknown>>)[0]).toMatchObject({
    duration: 7,
    imageAssetId: f.assets[1],
  })
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).not.toBeVisible()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(f.read).toEqual(before)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.id)).toBe(
    '刷新前改名',
  )
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(f.read).toEqual(after)
  expect(f.submissions).toEqual([])
})

test('只读时仍可打开已有样片，不重复创建或刷新已有剪辑', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.read()
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).not.toBeVisible()
  await f.open()
  await page.evaluate(
    () =>
      ((
        window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
      ).readOnly = true),
  )
  await page.getByRole('button', { name: '节奏样片', exact: true }).click()
  await expect(f.editor).toBeVisible()
  expect(await f.read()).toEqual(before)
  expect(
    await page.evaluate(
      () =>
        [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/animatic')
          .length,
    ),
  ).toBe(1)
})

test('只读时创建新样片有明确说明，保留分镜面板以便恢复后重试', async ({ page }) => {
  await board(page)
  await page.evaluate(
    () =>
      ((
        window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
      ).readOnly = true),
  )
  await page.getByRole('button', { name: '节奏样片', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toBeVisible()
  await expect(page.locator('.ui-toast')).toContainText('只读')
  expect(
    await page.evaluate(
      () =>
        [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/animatic')
          .length,
    ),
  ).toBe(0)
  await page.evaluate(
    () =>
      ((
        window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
      ).readOnly = false),
  )
  await page.getByRole('button', { name: '节奏样片', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '序列', exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/animatic')
          .length,
    ),
  ).toBe(1)
})
