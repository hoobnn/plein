import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'
import type { StoryboardBatchPlan } from '../packages/protocol/src/storyboard-batch'

async function fixture(page: Page, expanded = true) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '重新生成菜单测试',
      x: 300,
      y: 200,
      params: {
        shots: [
          {
            id: 'one',
            no: 1,
            duration: 3,
            description: '静物镜头',
            imagePrompt: '窗边水杯',
            sfx: '轻柔风声',
            dialogue: [{ id: 'line', character: '', line: '第一句旁白' }],
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
  }
  await open()
  if (expanded) {
    await editor.getByRole('button', { name: '展开为节点', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await open()
  }
  return { editor, trigger: editor.getByText('全部重新生成', { exact: true }) }
}

test('重新生成菜单 Esc 只收起菜单，分镜表保留且不提交任务', async ({ page }) => {
  const { editor, trigger } = await fixture(page)
  let submits = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/storyboard-batch/commit')) submits++
  })
  await trigger.click()
  const image = page.getByText('分镜图', { exact: true })
  await expect(image).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(image).toBeHidden()
  await expect(page.getByRole('menu', { name: '全部重新生成', includeHidden: true })).toHaveCount(0)
  await expect(editor).toBeVisible()
  await expect(editor).toHaveCSS('opacity', '1')
  await expect(trigger).toBeFocused()
  expect(submits).toBe(0)
})

test('未展开节点时禁用重新生成入口', async ({ page }) => {
  const { editor } = await fixture(page, false)
  await expect(editor.getByRole('button', { name: '全部重新生成', exact: true })).toBeDisabled()
  await expect(page.getByRole('menu', { name: '全部重新生成', exact: true })).toHaveCount(0)
})

test('关闭菜单回到按钮后，撤销重做仍操作分镜内容', async ({ page }) => {
  const { editor } = await fixture(page)
  await page.evaluate(() =>
    (
      window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        undo: { stopCapturing(): void }
      }
    ).undo.stopCapturing(),
  )
  const description = editor.getByRole('textbox', { name: '画面', exact: true })
  await description.fill('菜单操作前保存的修改')
  await description.blur()
  const trigger = editor.getByRole('button', { name: '全部重新生成', exact: true })
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('menu', { name: '全部重新生成', includeHidden: true })).toHaveCount(0)
  await expect(editor).toHaveCSS('opacity', '1')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(description).toHaveValue('静物镜头')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(description).toHaveValue('菜单操作前保存的修改')
})

test('菜单打开后叠加设置，菜单让位且 Esc 只关闭设置', async ({ page }) => {
  const { editor } = await fixture(page)
  const trigger = editor.getByRole('button', { name: '全部重新生成', exact: true })
  const menu = page.getByRole('menu', { name: '全部重新生成', exact: true })
  await trigger.click()
  await expect(menu).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await expect(
    page.getByRole('menu', { name: '全部重新生成', exact: true, includeHidden: true }),
  ).toBeHidden()
  await page.screenshot({ path: test.info().outputPath('settings-with-menu-dismissed.png') })
  await settings.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(editor).toBeVisible()
  await expect(trigger).toBeFocused()
})

test('重新生成菜单方向键导航、点击外部及窄屏定位', async ({ page }) => {
  const { editor } = await fixture(page)
  await page.setViewportSize({ width: 390, height: 700 })
  const trigger = editor.getByRole('button', { name: '全部重新生成', exact: true })
  const menu = page.getByRole('menu', { name: '全部重新生成', exact: true })
  await trigger.focus()
  await trigger.press('ArrowDown')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '分镜图', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: '音效', exact: true })).toBeFocused()
  for (const item of await menu.getByRole('menuitem').all()) await expect(item).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('regenerate-menu-390.png') })
  await page.keyboard.press('Home')
  await expect(menu.getByRole('menuitem', { name: '分镜图', exact: true })).toBeFocused()
  await editor.getByRole('heading', { name: '重新生成菜单测试', exact: true }).click()
  await expect(menu).toBeHidden()
  await expect(editor).toBeVisible()
})

test('快速取消后反复打开并改选生成类型，清单取消不锁住下一次操作', async ({ page }) => {
  const { editor } = await fixture(page)
  const trigger = editor.getByRole('button', { name: '全部重新生成', exact: true })
  const menu = page.getByRole('menu', { name: '全部重新生成', exact: true })
  const rawMenu = page.getByRole('menu', { name: '全部重新生成', exact: true, includeHidden: true })
  const description = editor.getByRole('textbox', { name: '画面', exact: true })
  let commits = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/storyboard-batch/commit')) commits++
  })
  for (const [label, role] of [
    ['分镜图', 'image'],
    ['配音', 'speech'],
    ['音效', 'sfx'],
  ] as const) {
    await description.fill(`本轮检查${label}`)
    await description.blur()
    await trigger.click()
    await page.keyboard.press('Escape')
    await expect(rawMenu).toHaveCount(0)
    await expect(editor).toHaveCSS('opacity', '1')
    await trigger.click()
    await expect(menu).toBeVisible()
    const response = page.waitForResponse((response) =>
      response.url().endsWith('/storyboard-batch/preview'),
    )
    await menu.getByRole('menuitem', { name: label, exact: true }).click()
    const plan = (await (await response).json()) as StoryboardBatchPlan
    expect(plan.request.role).toBe(role)
    expect(plan.request.reuseExisting).toBe(false)
    const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
    await checklist.getByRole('button', { name: '取消', exact: true }).click()
    await expect(checklist).toHaveCount(0)
    await expect(editor).toHaveCSS('opacity', '1')
    await expect(trigger).toBeFocused()
  }
  expect(commits).toBe(0)
})

test('菜单尚在打开等待时叠加设置，不迟到遮挡也不抢走设置按键', async ({ page }) => {
  const { editor } = await fixture(page)
  const description = editor.getByRole('textbox', { name: '画面', exact: true })
  await description.fill('打开设置前保存的画面')
  await description.blur()
  const trigger = editor.getByRole('button', { name: '全部重新生成', exact: true })
  await trigger.click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: '关闭', exact: true }).focus()
  await expect(
    page.getByRole('menu', { name: '全部重新生成', exact: true, includeHidden: true }),
  ).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(editor).toHaveCSS('opacity', '1')
  await expect(description).toHaveValue('打开设置前保存的画面')
  await trigger.click()
  const menu = page.getByRole('menu', { name: '全部重新生成', exact: true })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('menu', { name: '全部重新生成', exact: true, includeHidden: true }),
  ).toHaveCount(0)
  await expect(editor).toHaveCSS('opacity', '1')
})

for (const [label, role] of [
  ['分镜图', 'image'],
  ['视频', 'video'],
  ['配音', 'speech'],
  ['音效', 'sfx'],
] as const) {
  test(`重新生成${label}只打开对应清单，取消后焦点回到菜单按钮`, async ({ page }) => {
    const { editor } = await fixture(page)
    const trigger = editor.getByRole('button', { name: '全部重新生成', exact: true })
    const menu = page.getByRole('menu', { name: '全部重新生成', exact: true })
    let commits = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/storyboard-batch/commit'))
        commits++
    })
    await trigger.click()
    const response = page.waitForResponse((response) =>
      response.url().endsWith('/storyboard-batch/preview'),
    )
    await menu.getByRole('menuitem', { name: label, exact: true }).focus()
    await page.keyboard.press('Enter')
    const plan = (await (await response).json()) as StoryboardBatchPlan
    expect(plan.request.role).toBe(role)
    expect(plan.request.reuseExisting).toBe(false)
    const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
    await expect(checklist).toBeVisible()
    await expect(menu).toBeHidden()
    await expect
      .poll(() => checklist.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true)
    await checklist.getByRole('button', { name: '取消', exact: true }).click()
    await expect(checklist).toHaveCount(0)
    await expect(editor).toBeVisible()
    await expect(trigger).toBeFocused()
    expect(commits).toBe(0)
  })
}
