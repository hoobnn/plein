import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

for (const kind of ['sequence'] as const) {
  test(`${kind} 异常参数不击穿画布，显式恢复保留其他设置并可撤销重做`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const id = await page.evaluate(
      (kind) =>
        window.__plein.addNode({
          type: `plein/${kind}`,
          name: '异常参数恢复',
          x: 400,
          y: 200,
          params: {
            subtitles: false,
            resolution: '720p',
            aspectRatio: '16:9',
            clipVolume: 0.25,
            clips: [{ source: 'retained-clip', in: 0.2 }],
          },
        }),
      kind,
    )
    const write = (key: string, value: unknown) =>
      page.evaluate(
        ({ id, key, value }) => {
          const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
            set(k: string, v: unknown): void
          }
          params.set(key, value)
        },
        { id, key, value },
      )
    await write('resolution', '8K')
    const open = async () => {
      await clickElement(page, id)
      const at = await centerOf(page, id)
      await page.mouse.dblclick(at.x, at.y)
    }
    await open()
    const problem = page.getByRole('dialog', { name: '序列参数问题', exact: true })
    await expect(problem.getByRole('alert')).toContainText('分辨率')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.resolution, id),
    ).toBe('8K')
    await problem.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByRole('button', { name: '添加节点', exact: true })).toBeEnabled()
    await open()
    await problem.getByRole('button', { name: '恢复无效字段默认值', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await expect(editor).toBeVisible()
    const read = () => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!, id)
    expect(await read()).toMatchObject({
      resolution: '1080p',
      aspectRatio: '16:9',
      clipVolume: 0.25,
      clips: [{ source: 'retained-clip', in: 0.2 }],
    })
    await editor.getByRole('button', { name: '关闭', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(problem).toBeVisible()
    expect((await read()).resolution).toBe('8K')
    await problem.getByRole('button', { name: '重做', exact: true }).click()
    await expect(editor).toBeVisible()
    await write('clips', [{ source: 'retained-clip', in: -1 }])
    await expect(problem.getByRole('alert')).toContainText('镜头')
    await expect(problem).toContainText('列表会整体重置')
    await expect(
      problem.getByRole('button', { name: '恢复无效字段默认值', exact: true }),
    ).toBeInViewport()
    await problem.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})))
    })
    await page.screenshot({ path: testInfo.outputPath('parameter-recovery.png') })
    await page.evaluate(() => {
      ;(
        window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
      ).readOnly = true
      ;(
        window.__plein.engine as typeof window.__plein.engine & { refreshState(): void }
      ).refreshState()
    })
    const restore = problem.getByRole('button', { name: '恢复无效字段默认值', exact: true })
    await expect(restore).toBeDisabled()
    await page.evaluate(() => {
      ;(
        window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
      ).readOnly = false
      ;(
        window.__plein.engine as typeof window.__plein.engine & { refreshState(): void }
      ).refreshState()
    })
    await expect(restore).toBeEnabled()
    await restore.click()
    await expect(editor).toBeVisible()
    expect(await read()).toMatchObject({
      resolution: '1080p',
      aspectRatio: '16:9',
      clipVolume: 0.25,
      clips: [],
    })
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    expect(errors).toEqual([])
  })
}
