import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
for (const mode of ['replace', 'delete', 'retained'] as const) {
  test(`协作 ${mode} 后旧素材来源定位复核实际引用，恢复后可重新定位`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const ids: string[] = []
    for (const [i, color] of ['olive', 'pink'].entries()) {
      const data = execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=160x96`,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ])
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png', 'x-file-name': `source-fixture-${i}.png` },
        data,
      })
      expect(response.status()).toBe(201)
      ids.push(((await response.json()) as { id: string }).id)
    }
    const name = `协作来源-${mode}`
    const fixture = await page.evaluate(
      ({ name, ids }) => {
        const engine = window.__plein.engine as unknown as Engine
        const node = window.__plein.addNode({
          type: 'plein/image',
          name,
          params: {},
          x: 600,
          y: 300,
        })
        const safe = window.__plein.addNode({
          type: 'plein/text',
          name: '原有选区',
          params: { text: '不应被错误定位替换' },
          x: 200,
          y: 300,
        })
        engine.doc.mutable(node)!.set(
          'results',
          ids.map((assetId, i) => ({
            id: `candidate-${i}`,
            runId: 'fixture',
            port: 'images',
            value: { type: 'image', assetId },
            at: i + 1,
          })),
        )
        engine.doc.mutable(node)!.set('adopted', 'candidate-0')
        engine.selection.set([safe])
        engine.doc.flush()
        return { node, safe }
      },
      { name, ids },
    )
    const canvas = page.url().split('#/c/')[1]!
    await expect
      .poll(async () => {
        const body = (await (await page.request.get(`/api/assets/${ids[0]}/sources`)).json()) as {
          items: Array<{ nodeId: string }>
        }
        return body.items.some((item) => item.nodeId === fixture.node)
      })
      .toBe(true)
    const peer = await page.context().newPage()
    try {
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect
        .poll(() =>
          peer.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, fixture.node),
        )
        .toBe(2)
      const panel = page.getByRole('dialog', { name: '素材', exact: true })
      const open = async () => {
        await page.getByRole('button', { name: '素材', exact: true }).click()
        await panel.getByRole('combobox', { name: '关联项目' }).click()
        await page.getByRole('option', { name: '全部项目', exact: true }).click()
        await panel
          .getByRole('searchbox', { name: '搜索素材', exact: true })
          .fill('source-fixture-0')
        await panel
          .getByRole('button', { name: '查看素材 source-fixture-0.png', exact: true })
          .click()
      }
      await open()
      const source = panel.getByRole('listitem').filter({ hasText: ` / ${name}` })
      await expect(source).toHaveCount(1)
      await peer.evaluate(
        ({ id, mode }) => {
          const engine = window.__plein.engine as unknown as Engine
          engine.doc.undo.stopCapturing()
          engine.doc.ydoc.transact(() => {
            if (mode === 'delete') engine.doc.elementMaps.delete(id)
            else {
              const node = engine.doc.mutable(id)!
              if (mode === 'replace')
                node.set(
                  'results',
                  engine.doc.get(id)!.results!.filter((r) => r.id !== 'candidate-0'),
                )
              node.set('adopted', 'candidate-1')
            }
          }, engine.doc.origin)
          engine.doc.flush()
        },
        { id: fixture.node, mode },
      )
      await expect
        .poll(() =>
          page.evaluate(
            ({ id, mode }) => {
              const node = window.__plein.engine.doc.get(id)
              return mode === 'delete' ? !node : node?.adopted === 'candidate-1'
            },
            { id: fixture.node, mode },
          ),
        )
        .toBe(true)
      await source.getByRole('button', { name: '定位来源', exact: true }).click()
      await expect(panel).toHaveCount(0)
      expect(page.url()).toContain(`#/c/${canvas}`)
      await expect
        .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
        .toEqual([mode === 'retained' ? fixture.node : fixture.safe])
      if (mode !== 'retained') {
        await expect(
          page.getByText(
            mode === 'delete' ? '来源节点已不在画布上' : '来源节点已不再引用此素材，未执行定位',
            { exact: true },
          ),
        ).toBeVisible()
        await peer.evaluate(() => (window.__plein.engine as unknown as Engine).undo())
        await expect
          .poll(() =>
            page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, fixture.node),
          )
          .toBe(2)
        await expect
          .poll(async () => {
            const body = (await (
              await page.request.get(`/api/assets/${ids[0]}/sources`)
            ).json()) as { items: Array<{ nodeId: string }> }
            return body.items.some((item) => item.nodeId === fixture.node)
          })
          .toBe(true)
        await open()
        await source.getByRole('button', { name: '定位来源', exact: true }).click()
        await expect(panel).toHaveCount(0)
        await expect
          .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
          .toEqual([fixture.node])
      }
      expect(errors).toEqual([])
    } finally {
      await peer.close()
    }
  })
}
