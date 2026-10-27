import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { centerOf, clickElement, elements, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-sound-controls-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  ff(
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=96x64:d=30:r=5',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'shot.webm'),
  )
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=10', join(dir, 'sound.wav'))
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const [port, label] of [
  ['dialogue', '对白'],
  ['sfx', '音效'],
  ['music', '配乐'],
] as const) {
  test(`${label}读取失败后可静音继续预览，恢复音量后能重试`, async ({ page }) => {
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles([join(dir, 'shot.webm'), join(dir, 'sound.wav')])
    await expect
      .poll(
        async () =>
          (await elements(page)).filter((e) => e.kind === 'audio' || e.kind === 'video').length,
      )
      .toBe(2)
    const all = await elements(page)
    const video = all.find((e) => e.kind === 'video')!.id
    const audio = all.find((e) => e.kind === 'audio')!.id
    const asset = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.assetId!, audio)
    let blocked = true
    let reads = 0
    await page.route(`**/api/assets/${asset}`, (route) => {
      reads++
      return blocked ? route.fulfill({ status: 503, body: 'unavailable sound' }) : route.continue()
    })
    await page.evaluate(() => {
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        document.body.dataset.soundStarts = String(
          Number(document.body.dataset.soundStarts ?? 0) + 1,
        )
        return start.apply(this, args)
      }
    })
    const id = await page.evaluate(
      ({ video, audio, port }) => {
        const seq = window.__plein.addNode({
          type: 'plein/sequence',
          name: '声音交互',
          x: 700,
          y: 700,
          params: { clipVolume: 0, subtitles: false },
        })
        if (
          !window.__plein.connect([video, 'video'], [seq, 'clips']) ||
          !window.__plein.connect([audio, 'audio'], [seq, port])
        )
          throw new Error('连线失败')
        return seq
      },
      { video, audio, port },
    )
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const monitor = editor.locator('.seq-monitor')
    await monitor.getByRole('button', { name: '播放', exact: true }).click()
    await expect(monitor.getByRole('alert')).toContainText('预览素材读取失败')
    if (port !== 'music') {
      const choice = editor.getByRole('combobox', { name: label, exact: true })
      await choice.click()
      await page.getByRole('option', { name: '不配', exact: true }).click()
      await expect(choice).toHaveText('不配')
      await expect(monitor.getByRole('alert')).toHaveCount(0)
      const readsBefore = reads
      const time = await monitor.locator('.seq-time > span').first().innerText()
      await monitor.getByRole('button', { name: '播放', exact: true }).click()
      await expect(monitor.locator('.seq-time > span').first()).not.toHaveText(time)
      expect(reads).toBe(readsBefore)
      await monitor.getByRole('button', { name: '暂停', exact: true }).click()
      await choice.click()
      await page
        .getByRole('option', { name: all.find((e) => e.id === audio)!.name!, exact: true })
        .click()
      await monitor.getByRole('button', { name: '播放', exact: true }).click()
      await expect(monitor.getByRole('alert')).toContainText('预览素材读取失败')
    }
    await editor.getByRole('button', { name: '成片', exact: true }).click()
    const volume = editor.getByRole('slider', { name: label, exact: true })
    await volume.focus()
    await volume.press('Home')
    await expect(volume).toHaveValue('0')
    await expect
      .poll(() =>
        page.evaluate(
          ({ id, port }) => window.__plein.engine.doc.get(id)!.params![`${port}Volume`],
          { id, port },
        ),
      )
      .toBe(0)
    await expect(monitor.getByRole('alert')).toHaveCount(0)
    const before = reads
    const time = await monitor.locator('.seq-time > span').first().innerText()
    await monitor.getByRole('button', { name: '播放', exact: true }).click()
    await expect(monitor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await expect(monitor.locator('.seq-time > span').first()).not.toHaveText(time)
    expect(reads).toBe(before)
    await volume.focus()
    await volume.press('ArrowRight')
    await expect(volume).toHaveValue('0.05')
    await expect.poll(() => reads).toBeGreaterThan(before)
    await expect(monitor.getByRole('alert')).toContainText('预览素材读取失败')
    await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    blocked = false
    await monitor.getByRole('button', { name: '重试失败素材', exact: true }).click()
    await expect(monitor.getByRole('alert')).toHaveCount(0)
    await monitor.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0)))
      .toBeGreaterThan(0)
    await editor.screenshot({ path: test.info().outputPath(`${port}-restored.png`) })
  })
}

for (const cancel of ['pointercancel', 'blur', 'Escape', 'external'] as const) {
  test(`混音滑杆 ${cancel} 取消拖动，显示和保存值保持一致`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '滑杆取消',
        x: 400,
        y: 200,
        params: {
          subtitles: false,
          shots: [{ shotId: 'placeholder', duration: 30, dialogue: [] }],
        },
      }),
    )
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await editor.getByRole('button', { name: '成片', exact: true }).click()
    const slider = editor.getByRole('slider', { name: '对白', exact: true })
    const read = () =>
      page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.dialogueVolume ?? 1, id)
    await slider.scrollIntoViewIfNeeded()
    const box = (await slider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 4 })
    await expect(slider).not.toHaveValue('1')
    expect(await read()).toBe(1)
    const draft = await slider.inputValue()
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }))
    })
    await expect(slider).toHaveValue(draft)
    expect(await read()).toBe(1)
    const saved = cancel === 'external' ? 0.4 : 1
    if (cancel === 'Escape') {
      // 拖动中按 Esc 走真实编辑器关闭路径，退场期间松手不能保存草稿。
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect(editor).toBeHidden()
      await page.mouse.dblclick(at.x, at.y)
      await editor.getByRole('button', { name: '成片', exact: true }).click()
    } else {
      if (cancel === 'external')
        await page.evaluate((id) => {
          const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
            set(key: string, value: unknown): void
          }
          params.set('dialogueVolume', 0.4)
        }, id)
      else
        await page.evaluate(
          (kind) =>
            window.dispatchEvent(
              kind === 'blur'
                ? new Event('blur')
                : new PointerEvent('pointercancel', { pointerId: 1 }),
            ),
          cancel,
        )
      await expect(slider).toHaveValue(String(saved))
      // 取消后原生指针的迟到移动、松手都不能重新激活草稿。
      await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 2 })
      await expect(slider).toHaveValue(String(saved))
      await page.mouse.up()
    }
    expect(await read()).toBe(saved)
    await expect(slider).toHaveValue(String(saved))
    await expect(slider.locator('..').locator('.seq-volume-value')).toHaveText(`${saved * 100}%`)
    // 取消之后新的拖动仍可正常提交。
    await slider.scrollIntoViewIfNeeded()
    const next = (await slider.boundingBox())!
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2)
    await page.mouse.down()
    await page.mouse.move(next.x + next.width * 0.7, next.y + next.height / 2, { steps: 3 })
    const value = Number(await slider.inputValue())
    await page.mouse.up()
    await expect.poll(read).toBe(value)
    await slider.focus()
    await page.keyboard.down('ArrowRight')
    await page.keyboard.press('Tab')
    await page.keyboard.up('ArrowRight')
    await expect.poll(read).toBeCloseTo(value + 0.05)
  })
}
