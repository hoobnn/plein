import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('素材搜索校验长度且保留输入，支持完整表情、字面特殊字符和筛选恢复', async ({ page }) => {
  await newProject(page)
  const boundary = `${'界'.repeat(198)}🎬`
  const special = '边界检索%_\\杯子.png'
  const names = [`${boundary}.png`, special, '边界检索AB杯子.png']
  for (const [index, color] of ['yellow', 'teal', 'pink'].entries()) {
    const data = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=176x104`,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ])
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(names[index]!) },
      data,
    })
    expect(response.status()).toBe(201)
  }
  const requests: Array<{ q: string; kind: string | null }> = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/assets' && request.method() === 'GET')
      requests.push({ q: url.searchParams.get('q') ?? '', kind: url.searchParams.get('kind') })
  })
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '素材', exact: true })
  await panel.getByRole('combobox', { name: '关联项目' }).click()
  await page.getByRole('option', { name: '全部项目', exact: true }).click()
  const search = panel.getByRole('searchbox', { name: '搜索素材' })
  const cards = panel.getByRole('button', { name: /^查看素材 / })
  const longAsset = panel.getByRole('button', { name: `查看素材 ${names[0]}`, exact: true })
  await search.fill(boundary)
  await expect(longAsset).toBeVisible()
  await longAsset.click()
  await page.clock.install()
  await search.fill(`${boundary}呀`)
  await page.clock.fastForward(350)
  await expect(search).toHaveAttribute('aria-invalid', 'true')
  await expect(search).toHaveValue(`${boundary}呀`)
  await expect(search).toHaveAccessibleDescription(/最多 200/)
  await expect(panel.getByRole('button', { name: '刷新', exact: true })).toBeDisabled()
  await expect(panel.getByText('搜索内容过长', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '放入当前画布', exact: true })).toHaveCount(0)
  expect(requests.some(({ q }) => q.length > 200)).toBe(false)
  await panel.screenshot({
    path: test.info().outputPath('search-too-long.png'),
    animations: 'disabled',
  })
  await search.press('Backspace')
  await page.clock.fastForward(350)
  await expect(search).toHaveValue(boundary)
  await expect(search).toHaveAttribute('aria-invalid', 'false')
  await expect(longAsset).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await search.fill(`  ${boundary}  `)
  await page.clock.fastForward(350)
  await expect(longAsset).toBeVisible()
  await expect(search).toHaveAttribute('aria-invalid', 'false')
  for (const q of ['边界检索%_', '边界检索%_\\']) {
    await search.fill(`  ${q}  `)
    await page.clock.fastForward(350)
    await expect(cards).toHaveCount(1)
    await expect(
      panel.getByRole('button', { name: `查看素材 ${special}`, exact: true }),
    ).toBeVisible()
    expect(requests.at(-1)?.q).toBe(q)
  }
  await search.fill('  \t  ')
  await page.clock.fastForward(350)
  await expect(longAsset).toBeVisible()
  await expect(
    panel.getByRole('button', { name: `查看素材 ${special}`, exact: true }),
  ).toBeVisible()
  await search.fill('边界检索')
  await page.clock.fastForward(350)
  await expect(cards).toHaveCount(2)
  const kind = panel.getByRole('combobox', { name: '素材类型' })
  await kind.click()
  await page.getByRole('option', { name: '音频', exact: true }).click()
  await expect(panel.getByText('没有找到素材', { exact: true })).toBeVisible()
  await kind.click()
  await page.getByRole('option', { name: '图片', exact: true }).click()
  await expect(cards).toHaveCount(2)
  expect(requests.at(-1)).toEqual({ q: '边界检索', kind: 'image' })
  expect(requests.some(({ q }) => q.length > 200)).toBe(false)
  await expect(panel.getByRole('alert')).toHaveCount(0)
})
