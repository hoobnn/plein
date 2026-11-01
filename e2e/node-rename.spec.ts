import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { elements, newProject, waitEngine, zoomTo } from './canvas'

test('节点标题改名同步引用，支持取消、撤销与刷新持久化 @core', async ({ page }) => {
  await newProject(page)
  const { role, text } = await page.evaluate(() => ({
    role: window.__plein.addNode({ type: 'plein/character', name: '林夏', params: {}, x: 0, y: 0 }),
    text: window.__plein.addNode({
      type: 'plein/text',
      name: '故事说明',
      params: { text: '@林夏 在门口微笑' },
      x: 420,
      y: 0,
    }),
  }))
  await zoomTo(page, [role, text])
  await page.getByRole('button', { name: '重命名：林夏', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '重命名节点' })
  await dialog.getByRole('textbox').fill('林小夏')
  await dialog.getByRole('button', { name: '保存并同步引用' }).click()
  await expect(dialog).toBeHidden()
  const read = () =>
    page.evaluate(
      ({ role, text }) => ({
        name: window.__plein.engine.doc.get(role)?.name,
        text: window.__plein.engine.doc.get(text)?.params?.text,
      }),
      { role, text },
    )
  await expect.poll(read).toEqual({ name: '林小夏', text: '@林小夏 在门口微笑' })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(read).toEqual({ name: '林夏', text: '@林夏 在门口微笑' })
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(read).toEqual({ name: '林小夏', text: '@林小夏 在门口微笑' })
  await page.keyboard.press('F2')
  await dialog.getByRole('textbox').fill('不保存')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect.poll(read).toEqual({ name: '林小夏', text: '@林小夏 在门口微笑' })
  await page.reload()
  await waitEngine(page)
  await expect.poll(read).toEqual({ name: '林小夏', text: '@林小夏 在门口微笑' })
  await zoomTo(page, [text])
  await page.getByRole('button', { name: '重命名：故事说明', exact: true }).click()
  await dialog.getByRole('textbox').fill('新的说明')
  await dialog.getByRole('button', { name: '保存并同步引用' }).click()
  await expect(page.getByRole('button', { name: '重命名：新的说明', exact: true })).toBeVisible()
})

test('导入图片、视频、音频和 Markdown 均可从标题改名 @core', async ({ page }, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), 'plein-rename-'))
  try {
    const ff = (...args: string[]) =>
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
    ff('-f', 'lavfi', '-i', 'color=c=orange:s=64x48', '-frames:v', '1', join(dir, 'still.png'))
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=96x64:d=1:r=10',
      '-pix_fmt',
      'yuv420p',
      join(dir, 'clip.mp4'),
    )
    ff('-f', 'lavfi', '-i', 'sine=f=440:d=1', join(dir, 'voice.wav'))
    writeFileSync(join(dir, 'notes.md'), '# 工作流说明\n\n测试正文')
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (
      await chooser
    ).setFiles(['still.png', 'clip.mp4', 'voice.wav', 'notes.md'].map((file) => join(dir, file)))
    await expect.poll(async () => (await elements(page)).length).toBe(4)
    const imported = await elements(page)
    const dialog = page.getByRole('dialog', { name: '重命名节点' })
    for (const element of imported) {
      await zoomTo(page, [element.id])
      await page.evaluate((id) => window.__plein.engine.selection.set([id]), element.id)
      const title = page.locator('.plein-node-title')
      await expect(title).toHaveCount(1)
      await title.click()
      await dialog.getByRole('textbox').fill(`新的${element.kind}`)
      await dialog.getByRole('button', { name: '保存并同步引用' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(title).toHaveText(`新的${element.kind}`)
    }
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: testInfo.outputPath('renamed-media.png') })
    await page.reload()
    await waitEngine(page)
    await expect
      .poll(async () => (await elements(page)).map((el) => el.name ?? '').sort())
      .toEqual(imported.map((el) => `新的${el.kind}`).sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
