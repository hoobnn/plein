import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, deselect, newProject, zoomTo } from './canvas'

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
  return { ...f, boardId: f.id, id, image, editor, read, update, assets, submissions }
}

test('来源或采用结果损坏时拒绝整个刷新，修正后可重试且保留剪辑', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await fixture(page)
  await page.setViewportSize({ width: 800, height: 560 })
  const valid = [
    { id: 'one', no: 1, duration: 3 },
    { id: 'two', no: 2, duration: 2 },
  ]
  const refresh = f.editor.getByRole('button', { name: '更新已有素材', exact: true })
  for (const change of ['partial', 'list', 'duplicate', 'asset'] as const) {
    const before = await f.read()
    await page.evaluate(
      ({ boardId, image, valid, change }) => {
        const doc = window.__plein.engine.doc
        const params = doc.mutable(boardId)!.get('params') as { set(k: string, v: unknown): void }
        if (change === 'asset') {
          const node = doc.mutable(image)! as unknown as { set(k: string, v: unknown): void }
          node.set('results', [
            {
              id: 'broken',
              runId: 'broken',
              port: 'image',
              at: 3,
              value: { type: 'image', assetId: 'broken' },
            },
          ])
          node.set('adopted', 'broken')
        } else
          params.set(
            'shots',
            change === 'list'
              ? null
              : change === 'partial'
                ? [valid[0], { id: 'two', no: 2, duration: -1 }]
                : [valid[0], { id: 'one', no: 2, duration: 2 }],
          )
      },
      { boardId: f.boardId, image: f.image, valid, change },
    )
    await refresh.click()
    await expect(f.editor.getByRole('alert')).toContainText(
      change === 'asset' ? '已采用' : '来源分镜',
    )
    await expect(f.editor.getByRole('alert')).toContainText('已保留')
    expect(await f.read()).toEqual(before)
    expect(errors).toEqual([])
    await expect(f.editor.getByRole('alert')).toBeInViewport()
    expect(await f.editor.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    if (change === 'partial' || change === 'asset')
      await f.editor.screenshot({
        path: test.info().outputPath(`${change}-snapshot-refused.png`),
        animations: 'disabled',
      })
    if (change === 'partial') {
      await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(f.editor).not.toBeVisible()
      await deselect(page)
      await zoomTo(page, [f.id])
      const at = await centerOf(page, f.id)
      await page.mouse.dblclick(at.x, at.y)
      await expect(f.editor).toBeVisible()
      expect(await f.read()).toEqual(before)
      expect(
        await page.evaluate(
          () =>
            [...window.__plein.engine.doc.elements()].filter(
              (el) => el.nodeType === 'plein/animatic',
            ).length,
        ),
      ).toBe(1)
    }
    await page.evaluate(
      ({ boardId, valid }) => {
        const params = window.__plein.engine.doc.mutable(boardId)!.get('params') as {
          set(k: string, v: unknown): void
        }
        params.set('shots', valid)
      },
      { boardId: f.boardId, valid },
    )
    await f.update()
    await refresh.click()
    await expect(f.editor.getByRole('alert')).toHaveCount(0)
    expect((await f.read())!.shots).toMatchObject([
      { shotId: 'one', duration: 7, lineDelay: 0.5, lineGap: 0.8, imageAssetId: f.assets[1] },
      { shotId: 'two', duration: 2 },
    ])
  }
  expect(f.submissions).toEqual([])
})

for (const change of ['source', 'asset'] as const) {
  test(`首次创建样片遇到 ${change} 损坏不写入半成品，修复后可重试`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const f = await board(page)
    const image = await page.getByRole('button', { name: '节奏样片', exact: true }).evaluate(
      (button, { boardId, change }) => {
        if (change === 'source') {
          const params = window.__plein.engine.doc.mutable(boardId)!.get('params') as {
            set(k: string, v: unknown): void
          }
          params.set('shots', [
            { id: 'one', no: 1 },
            { id: 'two', no: 2, duration: -1 },
          ])
          ;(button as HTMLButtonElement).click()
          return ''
        }
        const id = window.__plein.addNode({
          type: 'plein/image',
          name: '损坏的采用结果',
          x: 900,
          y: 200,
          params: { source: { storyboard: boardId, shot: 'one', role: 'image' } },
        })
        const node = window.__plein.engine.doc.mutable(id)! as unknown as {
          set(k: string, v: unknown): void
        }
        node.set('results', [
          {
            id: 'broken',
            runId: 'broken',
            port: 'image',
            at: 1,
            value: { type: 'image', assetId: 'broken' },
          },
        ])
        node.set('adopted', 'broken')
        ;(button as HTMLButtonElement).click()
        return id
      },
      { boardId: f.id, change },
    )
    await expect(
      page.getByRole('dialog', {
        name: change === 'source' ? '分镜数据问题' : '分镜表',
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.locator('.ui-toast')).toContainText('无法创建样片')
    const drafts = () =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) => el.nodeType === 'plein/animatic')
            .length,
      )
    expect(await drafts()).toBe(0)
    expect(errors).toEqual([])
    await page.evaluate(
      ({ boardId, image }) => {
        const doc = window.__plein.engine.doc
        const params = doc.mutable(boardId)!.get('params') as { set(k: string, v: unknown): void }
        params.set('shots', [
          { id: 'one', no: 1, duration: 3 },
          { id: 'two', no: 2, duration: 2 },
        ])
        if (image) {
          const node = doc.mutable(image)! as unknown as { set(k: string, v: unknown): void }
          node.set('results', [])
          node.set('adopted', undefined)
        }
      },
      { boardId: f.id, image },
    )
    await page.getByRole('button', { name: '节奏样片', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '序列', exact: true })).toBeVisible()
    expect(await drafts()).toBe(1)
    expect(errors).toEqual([])
  })
}

test('样片素材刷新保留人工顺序，新增镜头追加且删除镜头不复活', async ({ page }) => {
  const f = await fixture(page)
  await f.editor.getByRole('button', { name: '后移', exact: true }).click()
  const shotIds = async () =>
    ((await f.read())!.shots as Array<{ shotId: string }>).map((s) => s.shotId)
  expect(await shotIds()).toEqual(['two', 'one'])
  const before = await f.read()
  await f.update()
  const refresh = f.editor.getByRole('button', { name: '更新已有素材', exact: true })
  await refresh.click()
  expect(await shotIds()).toEqual(['two', 'one'])
  const after = await f.read()
  expect((after!.shots as Array<Record<string, unknown>>)[1]).toMatchObject({
    duration: 7,
    lineDelay: 0.5,
    lineGap: 0.8,
    imageAssetId: f.assets[1],
  })
  await refresh.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(f.read).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toEqual(after)
  const writeShots = (shots: Array<{ id: string; no: number; duration: number }>) =>
    page.evaluate(
      ({ boardId, shots }) => {
        const params = window.__plein.engine.doc.mutable(boardId)!.get('params') as {
          set(k: string, v: unknown): void
        }
        params.set('shots', shots)
      },
      { boardId: f.boardId, shots },
    )
  await writeShots([
    { id: 'new', no: 1, duration: 4 },
    { id: 'one', no: 2, duration: 9 },
    { id: 'two', no: 3, duration: 2 },
  ])
  await refresh.click()
  expect(await shotIds()).toEqual(['two', 'one', 'new'])
  expect((await f.read())!.shots).toMatchObject([
    { shotId: 'two', duration: 2 },
    { shotId: 'one', duration: 7 },
    { shotId: 'new', duration: 4 },
  ])
  await expect(f.editor.locator('.seq-clip')).toHaveCount(3)
  await f.editor.screenshot({
    path: test.info().outputPath('preserved-shot-order.png'),
    animations: 'disabled',
  })
  await writeShots([
    { id: 'new', no: 1, duration: 8 },
    { id: 'two', no: 2, duration: 2 },
  ])
  await refresh.click()
  expect(await shotIds()).toEqual(['two', 'new'])
  expect((await f.read())!.shots).toMatchObject([{ duration: 2 }, { duration: 4 }])
  await expect(f.editor.locator('.seq-clip')).toHaveCount(2)
  expect(f.submissions).toEqual([])
})

for (const change of ['missing', 'readonly'] as const) {
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
