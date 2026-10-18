import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, waitEngine, zoomTo } from './canvas'

async function fixture(page: Page, expanded = false) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '分镜结构交互',
      x: 300,
      y: 200,
      params: {
        shots: [1, 2].map((no) => ({
          id: `shot-${no}`,
          no,
          duration: 3,
          description: `画面${no}`,
        })),
      },
    }),
  )
  const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
  const open = async () => {
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    await expect(dialog.getByRole('article')).toHaveCount(2)
  }
  await open()
  if (expanded) {
    await dialog.getByRole('button', { name: '展开为节点', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await open()
  }
  const read = () =>
    page.evaluate((id) => {
      const { doc } = window.__plein.engine
      return {
        shots: doc.get(id)?.params?.shots as Array<{ id: string; description: string }>,
        nodes: [...doc.elements()]
          .filter((el) => (el.params?.source as { storyboard?: string })?.storyboard === id)
          .map((el) => ({
            id: el.id,
            source: el.params!.source as { shot: string; detached?: boolean },
          })),
      }
    }, id)
  return { id, dialog, read }
}

for (const change of ['content', 'structure', 'readonly'] as const) {
  test(`删除确认期间${change}变化不删除新内容或脱离新增节点，核对后可重试`, async ({ page }) => {
    const f = await fixture(page, true)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await f.dialog.getByRole('button', { name: '删除镜头 1', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '删除镜头 01？', exact: true })
    await expect(confirmation).toBeVisible()
    if (change === 'content') {
      const peer = await page.context().newPage()
      try {
        await peer.goto(page.url())
        await waitEngine(peer)
        await zoomTo(peer, [f.id])
        const at = await centerOf(peer, f.id)
        await peer.mouse.dblclick(at.x, at.y)
        const description = peer
          .getByRole('dialog', { name: '分镜表', exact: true })
          .getByRole('article')
          .first()
          .getByLabel('画面', { exact: true })
        await description.fill('确认期间更新的画面')
        await description.blur()
        await expect
          .poll(async () => (await f.read()).shots[0]!.description)
          .toBe('确认期间更新的画面')
      } finally {
        await peer.close()
      }
    } else
      await page.evaluate(
        ({ id, change }) => {
          const { doc } = window.__plein.engine
          if (change === 'readonly') {
            ;(doc as typeof doc & { readOnly: boolean }).readOnly = true
          } else {
            window.__plein.addNode({
              type: 'plein/image',
              name: '确认期间新增分镜图',
              x: 1600,
              y: 1000,
              params: { source: { storyboard: id, shot: 'shot-1', role: 'image' } },
            })
          }
        },
        { id: f.id, change },
      )
    const before = await f.read()
    await confirmation.getByRole('button', { name: '删除镜头', exact: true }).click()
    await expect(confirmation).not.toBeVisible()
    await expect(f.dialog.getByRole('alert')).toContainText(
      change === 'readonly' ? '只读' : '已变化',
    )
    expect(await f.read()).toEqual(before)
    expect(errors).toEqual([])
    await f.dialog.screenshot({
      path: test.info().outputPath(`${change}-delete-refused.png`),
      animations: 'disabled',
    })
    if (change === 'readonly')
      await page.evaluate(() => {
        ;(
          window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
        ).readOnly = false
      })
    await f.dialog.getByRole('button', { name: '删除镜头 1', exact: true }).click()
    await expect(confirmation).toBeVisible()
    const affected = before.nodes.filter((node) => node.source.shot === 'shot-1')
    await expect(confirmation).toContainText(`${affected.length} 个节点`)
    await confirmation.getByRole('button', { name: '删除镜头', exact: true }).click()
    await expect(f.dialog.getByRole('article')).toHaveCount(1)
    expect(
      (await f.read()).nodes
        .filter((node) => node.source.shot === 'shot-1')
        .every((node) => node.source.detached),
    ).toBe(true)
    await expect(f.dialog.getByRole('alert')).toHaveCount(0)
  })
}

for (const action of ['delete', 'add'] as const) {
  test(`${action} 镜头独立撤销，不连带撤回前一次文本编辑`, async ({ page }) => {
    const f = await fixture(page)
    await page.evaluate(() =>
      (
        window.__plein.engine.doc as typeof window.__plein.engine.doc & {
          undo: { stopCapturing(): void }
        }
      ).undo.stopCapturing(),
    )
    await f.dialog
      .getByRole('article')
      .nth(1)
      .getByLabel('画面', { exact: true })
      .fill('保留第二镜的新画面')
    await f.dialog.evaluate(async (element, action) => {
      ;(document.activeElement as HTMLTextAreaElement).blur()
      await Promise.resolve()
      const button =
        action === 'delete'
          ? element.querySelector<HTMLButtonElement>('button[aria-label="删除镜头 1"]')
          : [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
              button.textContent?.includes('添加镜头'),
            )
      button!.click()
    }, action)
    await expect(f.dialog.getByRole('article')).toHaveCount(action === 'delete' ? 1 : 3)
    await f.dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(f.dialog).not.toBeVisible()
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(async () => (await f.read()).shots.length).toBe(2)
    expect((await f.read()).shots[1]!.description).toBe('保留第二镜的新画面')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(async () => (await f.read()).shots.length).toBe(action === 'delete' ? 1 : 3)
    expect((await f.read()).shots.find((shot) => shot.id === 'shot-2')!.description).toBe(
      '保留第二镜的新画面',
    )
  })
}

test('已展开镜头可取消删除，确认后节点保留且撤销重做整体恢复关联', async ({ page }) => {
  const f = await fixture(page, true)
  const before = await f.read()
  const confirmation = page.getByRole('dialog', { name: '删除镜头 01？', exact: true })
  await f.dialog.getByRole('button', { name: '删除镜头 1', exact: true }).click()
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  expect(await f.read()).toEqual(before)
  await f.dialog.getByRole('button', { name: '删除镜头 1', exact: true }).click()
  await expect(confirmation).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await f.read()).toEqual(before)
  await confirmation.getByRole('button', { name: '删除镜头', exact: true }).click()
  await expect(f.dialog.getByRole('article')).toHaveCount(1)
  const removed = await f.read()
  expect(removed.nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id))
  expect(
    removed.nodes
      .filter((node) => node.source.shot === 'shot-1')
      .every((node) => node.source.detached),
  ).toBe(true)
  const description = f.dialog.getByRole('article').first().getByLabel('画面', { exact: true })
  await description.focus()
  await description.evaluate((input: HTMLTextAreaElement) =>
    input.setSelectionRange(input.value.length, input.value.length),
  )
  await description.pressSequentially('B')
  await expect(description).toHaveValue('画面2B')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(description).toHaveValue('画面2')
  expect(await f.read()).toEqual(removed)
  await f.dialog.getByRole('button', { name: '添加镜头', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(f.read).toEqual(before)
  await expect(f.dialog.getByRole('article')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toEqual(removed)
  await f.dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.dialog).not.toBeVisible()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(f.read).toEqual(before)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(f.read).toEqual(removed)
})

test('分镜文本光标可移动，原生撤销重做不改变镜头结构', async ({ page }) => {
  const f = await fixture(page)
  const before = await f.read()
  const input = f.dialog.getByRole('article').first().getByLabel('画面', { exact: true })
  await input.focus()
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0))
  await page.keyboard.press('ArrowRight')
  expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(1)
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  )
  await input.pressSequentially('B')
  await expect(input).toHaveValue('画面1B')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(input).toHaveValue('画面1')
  expect(await f.read()).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(input).toHaveValue('画面1B')
  expect(await f.read()).toEqual(before)
  await input.blur()
  await expect.poll(async () => (await f.read()).shots[0]!.description).toBe('画面1B')
})
