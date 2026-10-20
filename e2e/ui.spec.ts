import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

const SHOTS = process.env.PLEIN_SHOTS ?? 'test-results'

/** 基础浮层（Base UI）：弹层、下拉、开关、面板、确认框的打开、关闭、键盘和焦点 */
test('弹层、下拉、开关、面板、确认框的交互', async ({ page }) => {
  await newProject(page)

  // 工具单击立即切换，键盘快捷键与按钮保持一致。
  const tools = page.getByRole('button', { name: '工具', exact: true })
  const toolsPop = page.getByRole('dialog', { name: '工具' })
  await expect(tools).toHaveAttribute('aria-pressed', 'false')
  await tools.click()
  await expect(tools).toHaveAttribute('aria-pressed', 'true')
  await expect(tools).toHaveAttribute('title', /当前：抓手；点击切换为移动/)
  await expect(toolsPop).toHaveCount(0)
  await tools.click()
  await expect(tools).toHaveAttribute('aria-pressed', 'false')
  await expect(tools).toHaveAttribute('title', /当前：移动；点击切换为抓手/)
  await page.locator('canvas').evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
  await page.keyboard.press('h')
  await expect(tools).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('v')
  await expect(tools).toHaveAttribute('aria-pressed', 'false')

  // 缩放弹层打开就能输入倍数
  await page.getByRole('button', { name: '缩放选项' }).click()
  await expect(page.getByRole('textbox', { name: '缩放百分比' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '缩放' })).toHaveCount(0)

  // 面板：焦点移进去，Esc 由面板自己关，关闭后焦点还给按钮
  const settingsBtn = page.getByRole('button', { name: '设置', exact: true })
  await settingsBtn.click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await expect(settings).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/settings.png` })

  // 开关（模型平台页的启用开关）：点一下切换状态，再点回来
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  const sw = settings.getByRole('switch').first()
  await expect(sw).toBeVisible()
  const before = await sw.getAttribute('aria-checked')
  await sw.click()
  await expect(sw).not.toHaveAttribute('aria-checked', before ?? '')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', before ?? '')

  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(settingsBtn).toBeFocused()

  // 点遮罩关闭
  await settingsBtn.click()
  await expect(settings).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(settings).toHaveCount(0)

  // 输入框：输入框获得焦点并全选默认值，Esc 取消（回车新建见 projects.spec）
  const switcher = page.getByRole('button', { name: '切换画布' })
  await switcher.click()
  await page.getByRole('button', { name: '新建画布' }).click()
  const prompt = page.getByRole('dialog', { name: '新建画布' })
  const input = prompt.getByRole('textbox')
  await expect(input).toBeFocused()
  expect(
    await input.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!),
  ).toBe((await input.inputValue()).length)
  await page.screenshot({ path: `${SHOTS}/prompt.png` })
  await page.keyboard.press('Escape')
  await expect(prompt).toHaveCount(0)

  // 菜单式下拉（侧栏按类型筛选）：方向键移动、回车选中，关闭后焦点回到按钮
  const filter = page.getByRole('button', { name: '按类型筛选' })
  await filter.click()
  const menu = page.getByRole('menu', { name: '按类型筛选' })
  await expect(menu).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/menu.png` })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(filter).toContainText('分组')
  await expect(filter).toBeFocused()

  // 面板里的下拉：选项点了只关下拉；Esc 先关下拉，再按一次才关面板
  await page.getByRole('button', { name: '资产库' }).click()
  const lib = page.getByRole('dialog', { name: '资产库' })
  await expect(lib).toBeVisible()
  const combo = lib.getByRole('combobox').first()
  await combo.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/select.png` })
  const second = listbox.getByRole('option').nth(1)
  const picked = await second.innerText()
  await second.click()
  await expect(listbox).toHaveCount(0)
  await expect(lib).toBeVisible()
  await expect(combo).toHaveText(picked)
  await combo.click()
  await expect(listbox).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(listbox).toHaveCount(0)
  await expect(lib).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lib).toHaveCount(0)
})
