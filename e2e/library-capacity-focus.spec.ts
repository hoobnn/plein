import { expect, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

const files = Array.from({ length: 25 }, (_, i) => ({
  name: `reference-${i + 1}.png`,
  mimeType: 'image/png',
  buffer: Buffer.from(solidPng(64, 48, [12 + i * 7, 120, 180])),
}))
const assets: string[] = []
test.beforeAll(async ({ request }) => {
  for (const file of files) {
    const uploaded = await request.post('/api/assets', {
      headers: { 'Content-Type': file.mimeType },
      data: file.buffer,
    })
    expect(uploaded.status()).toBe(201)
    assets.push((await uploaded.json()).id)
  }
})
async function fixture(page: Page, count: number) {
  await newProject(page)
  await page.evaluate((assetId) => {
    const e = window.__plein.engine as typeof window.__plein.engine & { paste(data: unknown): void }
    e.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'candidate',
          kind: 'image',
          name: '补齐最后一张',
          assetId,
          x: 300,
          y: 200,
          w: 160,
          h: 120,
          parentId: null,
        },
      ],
    })
  }, assets[23]!)
  const name = `容量恢复 ${count} ${page.url().split('/').at(-1)}`
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name,
      description: '保留角色身份',
      images: assets.slice(0, count).map((assetId) => ({ slot: 'extra', assetId })),
    },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  const extras = panel.locator('details.lib-character-extras')
  const field = () => extras.getByRole('group', { name: '添加补充参考', exact: true })
  const input = () => extras.locator('input[type="file"]')
  const save = async () => {
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    return (await page.request.get(`/api/library/${item.id}`)).json()
  }
  const read = async () => (await page.request.get(`/api/library/${item.id}`)).json()
  return { panel, extras, field, input, save, read, name }
}
async function upload(page: Page, f: Awaited<ReturnType<typeof fixture>>, indexes: number[]) {
  const chooser = page.waitForEvent('filechooser')
  await f.extras.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(indexes.map((i) => files[i]!))
}
async function full(f: Awaited<ReturnType<typeof fixture>>) {
  await expect(f.extras.getByText('已达到 24 张参考图上限。', { exact: true })).toBeVisible()
  await expect(f.extras.getByRole('button', { name: '预览其他参考 24', exact: true })).toBeFocused()
  expect((await f.save()).images).toEqual(
    assets.slice(0, 24).map((assetId) => ({ slot: 'extra', assetId })),
  )
}

test('画布补齐第24张后添加入口退出，焦点移到刚加入的参考图', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 })
  const f = await fixture(page, 23)
  await f.extras.getByRole('button', { name: '从画布选', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '从画布选', exact: true })
  await picker.getByRole('button', { name: '选择图片「补齐最后一张」', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(picker).toHaveCount(0)
  await expect(f.extras.getByRole('button', { name: '预览其他参考 24', exact: true })).toBeFocused()
  await f.panel.screenshot({
    path: test.info().outputPath('capacity-filled-focus.png'),
    animations: 'disabled',
  })
  await full(f)
})

for (const count of [24, 1]) {
  test(`从${count}张移除末张后保留键盘位置，恢复添加并正确保存`, async ({ page }) => {
    const f = await fixture(page, count)
    const remove = f.extras.getByRole('button', { name: `移除其他参考 ${count}`, exact: true })
    await remove.focus()
    await page.keyboard.press('Enter')
    if (count === 1) {
      const summary = f.extras.locator('summary')
      await expect(summary).toBeFocused()
      await page.keyboard.press('Enter')
    } else
      await expect(
        f.extras.getByRole('button', { name: `预览其他参考 ${count - 1}`, exact: true }),
      ).toBeFocused()
    await expect(f.extras.getByRole('button', { name: '上传', exact: true })).toBeVisible()
    expect((await f.save()).images).toEqual(
      assets.slice(0, count - 1).map((assetId) => ({ slot: 'extra', assetId })),
    )
  })
}

test('满额参考归入四类图片后焦点移到对应形象，保存不丢任何素材', async ({ page }) => {
  const f = await fixture(page, 24)
  const classify = f.extras.getByRole('combobox', { name: '参考图 1 的分类', exact: true })
  await classify.click()
  await expect(classify).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(classify).toHaveAttribute('aria-expanded', 'false')
  await expect(classify).toBeFocused()
  await classify.click()
  await page.getByRole('option', { name: '其他参考', exact: true }).click()
  await expect(classify).toBeFocused()
  await classify.click()
  await page.getByRole('option', { name: '全身定妆图', exact: true }).click()
  const preview = f.panel.getByRole('button', { name: '预览全身定妆图', exact: true })
  await expect(preview).toBeFocused()
  await expect(preview).toBeInViewport({ ratio: 1 })
  const saved = await f.save()
  expect(saved.images).toHaveLength(24)
  expect(saved.images.map((image: { assetId: string }) => image.assetId).sort()).toEqual(
    assets.slice(0, 24).sort(),
  )
  expect(saved.images).toContainEqual({ slot: 'full_body', assetId: assets[0] })
})

test('批量上传填满最后两个位置后聚焦最后一张，实际保存完整顺序', async ({ page }) => {
  const f = await fixture(page, 22)
  await upload(page, f, [22, 23])
  await full(f)
})

test('填满上传等待期间继续编辑名称，完成后不抢焦点也不覆盖后续编辑', async ({ page }) => {
  const f = await fixture(page, 23)
  let ready = false,
    release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/assets', async (route) => {
    const response = await route.fetch()
    ready = true
    await gate
    await route.fulfill({ response })
  })
  try {
    await upload(page, f, [23])
    await expect.poll(() => ready).toBe(true)
    const name = f.panel.getByRole('textbox', { name: '名称', exact: true })
    await name.fill(`${f.name}继续编辑`)
    release()
    await expect(f.extras.getByText('已达到 24 张参考图上限。', { exact: true })).toBeVisible()
    await expect(name).toBeFocused()
    const saved = await f.save()
    expect(saved.name).toBe(`${f.name}继续编辑`)
    expect(saved.images).toHaveLength(24)
  } finally {
    release()
  }
})

test('最后一张上传失败保留字段焦点，修正后可继续键盘上传并保存', async ({ page }) => {
  const f = await fixture(page, 23)
  await page.route(
    '**/api/assets',
    (route) => route.fulfill({ status: 503, json: { message: '测试暂时上传失败' } }),
    { times: 1 },
  )
  await upload(page, f, [23])
  await expect(f.extras.getByRole('alert')).toContainText('测试暂时上传失败')
  await expect(f.field()).toBeFocused()
  expect((await f.read()).images).toHaveLength(23)
  await page.keyboard.press('Tab')
  await expect(f.extras.getByRole('button', { name: '上传', exact: true })).toBeFocused()
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  await (await chooser).setFiles(files[23]!)
  await full(f)
})

for (const count of [23, 22]) {
  test(`从${count}张混合拖入至满额后保留跳过说明，移除重传后清除旧说明`, async ({ page }) => {
    if (count === 22) await page.setViewportSize({ width: 800, height: 650 })
    const f = await fixture(page, count)
    const button = f.extras.getByRole('button', { name: '上传', exact: true })
    await button.focus()
    const payload = files.slice(count, 24).map((file) => ({
      name: file.name,
      type: file.mimeType,
      body: file.buffer.toString('base64'),
    }))
    payload.unshift({
      name: 'note.txt',
      type: 'text/plain',
      body: Buffer.from('备注').toString('base64'),
    })
    const transfer = await page.evaluateHandle((payload) => {
      const data = new DataTransfer()
      for (const file of payload)
        data.items.add(
          new File([Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0))], file.name, {
            type: file.type,
          }),
        )
      return data
    }, payload)
    try {
      await button.dispatchEvent('drop', { dataTransfer: transfer })
    } finally {
      await transfer.dispose()
    }
    await expect(f.extras.getByText('已达到 24 张参考图上限。', { exact: true })).toBeVisible()
    await expect(f.extras.getByRole('status')).toContainText('已跳过 1 个非图片文件')
    if (count === 23)
      await f.panel.screenshot({
        path: test.info().outputPath('capacity-upload-notice.png'),
        animations: 'disabled',
      })
    await full(f)
    await expect(f.extras.getByRole('status')).toContainText('已跳过 1 个非图片文件')
    await f.extras.getByRole('button', { name: '移除其他参考 24', exact: true }).click()
    await upload(page, f, [24])
    await expect(f.extras.getByText('已达到 24 张参考图上限。', { exact: true })).toBeVisible()
    await expect(f.extras.getByRole('status')).toHaveCount(0)
    await expect(
      f.extras.getByRole('button', { name: '预览其他参考 24', exact: true }),
    ).toBeFocused()
    expect((await f.save()).images).toEqual(
      [...assets.slice(0, 23), assets[24]].map((assetId) => ({ slot: 'extra', assetId })),
    )
  })
}

test('最后一个画布候选自动收起期间 Esc 不穿透，收起后可正常返回与关闭', async ({ page }) => {
  const f = await fixture(page, 1)
  const trigger = f.extras.getByRole('button', { name: '从画布选', exact: true })
  await trigger.click()
  const picker = page.getByRole('dialog', { name: '从画布选', exact: true })
  // 只用 DOM 的退场标记固定事件发生在动画内，不依赖机器速度猜测间隔。
  await picker.evaluate((el) => {
    const anchor = document.querySelector<HTMLButtonElement>(
      '.lib-character-extras button[aria-label="从画布选"]',
    )!
    const observer = new MutationObserver(() => {
      if (!el.hasAttribute('data-closing')) return
      observer.disconnect()
      anchor.setAttribute('data-close-escape', 'sent')
      anchor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    observer.observe(el, { attributes: true, attributeFilter: ['data-closing'] })
  })
  await picker.getByRole('button', { name: '选择图片「补齐最后一张」', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('data-close-escape', 'sent')
  await expect(picker).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(f.panel.getByRole('textbox', { name: '名称', exact: true })).toBeVisible()
  expect((await f.save()).images).toEqual(
    [assets[0], assets[23]].map((assetId) => ({ slot: 'extra', assetId })),
  )
  await page.keyboard.press('Escape')
  await expect(f.panel.getByRole('textbox', { name: '名称', exact: true })).toHaveCount(0)
  await expect(f.panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(f.panel).toHaveCount(0)
})
