import type { Project } from '../packages/protocol/src/projects'
import { expect, test } from './fixtures'

for (const width of [320, 1440]) {
  test(`首页按画布名重开项目中的旧画布（${width}px）`, async ({ page, request }) => {
    const projectName = `分镜项目 ${width}`
    const projectResponse = await request.post('/api/projects', { data: { title: projectName } })
    expect(projectResponse.status()).toBe(201)
    const project = (await projectResponse.json()) as Project
    const name = '第一集 · 开场分镜'
    expect(
      (
        await request.patch(`/api/canvases/${project.lastCanvasId}`, { data: { title: name } })
      ).ok(),
    ).toBe(true)
    expect(
      (
        await request.post('/api/canvases', {
          data: { projectId: project.id, title: '第二集 · 配音' },
        })
      ).ok(),
    ).toBe(true)
    await page.addInitScript(() => localStorage.setItem('plein.welcome', '1'))
    await page.setViewportSize({ width, height: 720 })
    await page.goto('/')

    const open = page.getByRole('button', { name: `选择「${projectName}」的画布，共 2 张` })
    await open.click()
    const dialog = page.getByRole('dialog', { name: `选择画布 · ${projectName}` })
    await expect(dialog.getByRole('link').first()).toContainText('第二集 · 配音')
    await dialog.getByRole('searchbox', { name: '搜索画布' }).fill('开场')
    const target = dialog.getByRole('link', { name: /开场分镜/ })
    await expect(target).toBeInViewport()
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await target.click()
    await expect(page).toHaveURL(new RegExp(`#/c/${project.lastCanvasId}$`))
    await expect(page.getByRole('button', { name: '切换画布' })).toHaveText(name)
  })
}
