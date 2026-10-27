import { expect, type Page, test } from './fixtures'
import { centerOf, newProject, openStoryboardActions, showStoryboardCards, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '分镜同步边界',
      x: 300,
      y: 200,
      params: {
        shots: [
          {
            id: 'shot-1',
            no: 1,
            duration: 3,
            description: '初始画面',
            imagePrompt: '初始分镜图',
            motionPrompt: '初始运动',
          },
        ],
      },
    }),
  )
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  const open = async () => {
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    await expect(editor).toBeVisible()
    await openStoryboardActions(editor)
  }
  await open()
  await editor.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await open()
  await showStoryboardCards(editor)
  const prompt = editor.getByLabel('分镜图提示词', { exact: true })
  await prompt.fill('计划改后的分镜图')
  await prompt.blur()
  await editor.getByRole('button', { name: /^查看差异/ }).click()
  const panel = page.getByRole('dialog', { name: '计划差异', exact: true })
  await expect(panel.getByText('计划改后的分镜图 景别：中景', { exact: true })).toBeVisible()
  const read = () =>
    page.evaluate((id) => {
      const { doc } = window.__plein.engine
      return [...doc.elements()]
        .filter((el) => (el.params?.source as { storyboard?: string })?.storyboard === id)
        .map((el) => ({ id: el.id, params: el.params }))
    }, id)
  return { id, editor, panel, read }
}

for (const kind of ['sync', 'batch'] as const) {
  test(`${kind} 子窗口叠加设置，Esc 只关闭最上层并逐层恢复焦点`, async ({ page }) => {
    const f = await fixture(page)
    let panel = f.panel
    if (kind === 'batch') {
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      await f.editor.getByRole('button', { name: '批量出分镜图', exact: true }).click()
      panel = page.getByRole('dialog', { name: '批量生成清单', exact: true })
      await expect(panel.getByLabel('清单汇总')).toBeVisible()
    }
    const close = panel.getByRole('button', { name: '关闭', exact: true })
    await close.focus()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: '关闭', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(close).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(f.editor).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(f.editor).toHaveCount(0)
  })
}

for (const mode of ['unmodified', 'keep-overrides'] as const) {
  const label = mode === 'unmodified' ? '同步计划改动' : '不同步，按节点现状'
  for (const change of ['plan', 'actual', 'readonly', 'node-delete', 'shot-delete'] as const) {
    test(`${label} 前同帧 ${change} 变化拒绝旧操作，核对新差异后可重试`, async ({ page }) => {
      const f = await fixture(page)
      if (change === 'actual') {
        await page.setViewportSize({ width: 390, height: 700 })
        expect(
          await f.panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true)
        await expect(f.panel.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
        await expect(f.panel.getByRole('button', { name: label, exact: true })).toBeInViewport()
      }
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const before = await f.panel.getByRole('button', { name: label, exact: true }).evaluate(
        (button, { id, change }) => {
          const { doc } = window.__plein.engine
          if (change === 'readonly') (doc as typeof doc & { readOnly: boolean }).readOnly = true
          else if (change === 'plan') {
            const params = doc.mutable(id)!.get('params') as {
              set(key: string, value: unknown): void
            }
            const shots = doc.get(id)!.params!.shots as Array<Record<string, unknown>>
            params.set(
              'shots',
              shots.map((shot) => ({ ...shot, imagePrompt: '同帧更新的计划图' })),
            )
          } else if (change === 'node-delete' || change === 'shot-delete') {
            const engine = window.__plein.engine as typeof window.__plein.engine & {
              deleteSelection(): void
              doc: {
                origin: unknown
                undo: { stopCapturing(): void }
                ydoc: { transact(fn: () => void, origin: unknown): void }
              }
            }
            engine.doc.undo.stopCapturing()
            if (change === 'shot-delete') {
              engine.doc.ydoc.transact(() => {
                ;(doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }).set(
                  'shots',
                  [],
                )
              }, engine.doc.origin)
            } else {
              const image = [...doc.elements()].find(
                (el) =>
                  (el.params?.source as { storyboard?: string; role?: string })?.storyboard ===
                    id && (el.params?.source as { role?: string })?.role === 'image',
              )!
              engine.selection.set([image.id])
              engine.deleteSelection()
            }
            engine.doc.undo.stopCapturing()
          } else {
            const image = [...doc.elements()].find(
              (el) =>
                (el.params?.source as { storyboard?: string; role?: string })?.storyboard === id &&
                (el.params?.source as { role?: string })?.role === 'image',
            )!
            const params = doc.mutable(image.id)!.get('params') as {
              set(key: string, value: unknown): void
            }
            params.set('prompt', '同帧手改的分镜图')
          }
          const before = [...doc.elements()]
            .filter((el) => (el.params?.source as { storyboard?: string })?.storyboard === id)
            .map((el) => ({ id: el.id, params: el.params }))
          ;(button as HTMLButtonElement).click()
          return before
        },
        { id: f.id, change },
      )
      expect(await f.read()).toEqual(before)
      expect(errors).toEqual([])
      await expect(f.panel.getByRole('alert')).toContainText(
        change === 'readonly' ? '只读' : '差异已变化',
      )
      if (change === 'readonly' || change === 'node-delete' || change === 'shot-delete') {
        await expect(
          f.panel.getByRole('button', { name: '同步计划改动', exact: true }),
        ).toBeDisabled()
        await expect(
          f.panel.getByRole('button', { name: '不同步，按节点现状', exact: true }),
        ).toBeDisabled()
      }
      if (change === 'node-delete' || change === 'shot-delete') {
        await expect(f.panel.getByText('没有待处理的差异', { exact: true })).toBeVisible()
        await page.evaluate(() =>
          (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
        )
        await expect(
          f.panel.getByText('计划改后的分镜图 景别：中景', { exact: true }),
        ).toBeVisible()
      }
      if (change === 'readonly')
        await page.evaluate((id) => {
          const { doc } = window.__plein.engine
          ;(doc as typeof doc & { readOnly: boolean }).readOnly = false
          ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
            'name',
            '恢复可编辑的分镜',
          )
        }, f.id)
      else if (change === 'plan' || change === 'actual')
        await expect(
          f.panel.getByText(
            change === 'plan' ? '同帧更新的计划图 景别：中景' : '同帧手改的分镜图',
            {
              exact: true,
            },
          ),
        ).toBeVisible()
      await f.panel.screenshot({
        path: test.info().outputPath(`${mode}-${change}-refused.png`),
        animations: 'disabled',
      })
      if (change === 'actual')
        await expect(
          f.panel
            .getByRole('listitem', { name: '提示词差异', exact: true })
            .locator('dt')
            .filter({ hasText: /^分镜计划$/ })
            .locator('..')
            .locator('dd'),
        ).toHaveText('计划改后的分镜图 景别：中景')
      await f.panel.getByRole('button', { name: label, exact: true }).click()
      await expect(f.panel.getByText('没有待处理的差异', { exact: true })).toBeVisible()
      await expect(f.panel.getByRole('alert')).toHaveCount(0)
      const image = (await f.read()).find(
        (node) => (node.params?.source as { role?: string })?.role === 'image',
      )!
      expect(image.params!.prompt).toBe(
        change === 'actual'
          ? '同帧手改的分镜图'
          : mode === 'keep-overrides'
            ? '初始分镜图 景别：中景'
            : change === 'plan'
              ? '同帧更新的计划图 景别：中景'
              : '计划改后的分镜图 景别：中景',
      )
    })
  }

  test(`${label} 独立撤销，不撤回同帧的无关改名，重做恢复整组同步状态`, async ({ page }) => {
    const f = await fixture(page)
    const before = await f.read()
    await f.panel.getByRole('button', { name: label, exact: true }).evaluate((button, id) => {
      const { doc } = window.__plein.engine
      ;(doc as typeof doc & { undo: { stopCapturing(): void } }).undo.stopCapturing()
      const editable = doc as typeof doc & {
        origin: unknown
        ydoc: { transact(fn: () => void, origin: unknown): void }
      }
      editable.ydoc.transact(() => {
        ;(doc.mutable(id)! as unknown as { set(key: string, value: unknown): void }).set(
          'name',
          '同步前改名',
        )
      }, editable.origin)
      ;(button as HTMLButtonElement).click()
    }, f.id)
    await expect(f.panel.getByText('没有待处理的差异', { exact: true })).toBeVisible()
    const synced = await f.read()
    await f.panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(f.panel).not.toBeVisible()
    await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(f.editor).not.toBeVisible()
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(f.read).toEqual(before)
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.id)).toBe(
      '同步前改名',
    )
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(f.read).toEqual(synced)
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, f.id)).toBe(
      '同步前改名',
    )
  })
}
