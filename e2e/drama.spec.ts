import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import {
  byName,
  centerOf,
  contextMenu,
  edgesInto,
  elements,
  waitEngine,
  waitIdle,
  waitNode,
  zoomTo,
} from './canvas'

const hasLibass = () => {
  try {
    return / ass /.test(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }))
  } catch {
    return false
  }
}

test('短剧模板：插入 → 跑骨架 → 展开 → 批量 → 导出', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await expect(page).toHaveURL(/#\/c\//)
  await waitEngine(page)

  await page.mouse.dblclick(720, 450)
  await page.getByPlaceholder('添加节点').fill('短剧')
  await page.keyboard.press('Enter')
  await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')

  const board = await byName(page, '分镜（双击展开镜头）')
  await zoomTo(page, [board.id])
  await contextMenu(page, board.id, '运行到此处')
  await waitNode(page, board.id)
  await expect(page.locator('.ui-toast')).toContainText('运行完成')

  // 角色与场景抽取 → 一键落成设定卡
  const cast = await byName(page, '角色与场景抽取')
  await zoomTo(page, [cast.id])
  await contextMenu(page, cast.id, '运行到此处')
  await waitNode(page, cast.id)
  await expect(page.locator('.ui-toast')).toContainText('运行完成')
  await contextMenu(page, cast.id, '生成设定卡（3）')
  await expect(page.locator('.ui-toast')).toContainText('新建 3 张设定卡')
  expect((await byName(page, '林晚')).nodeType).toBe('plein/character')
  expect((await byName(page, '老城区天台')).nodeType).toBe('plein/scene')

  const openBoard = async () => {
    await zoomTo(page, [board.id])
    const p = await centerOf(page, board.id)
    await page.mouse.dblclick(p.x, p.y)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    return dialog
  }
  let dialog = await openBoard()
  await dialog.getByRole('button', { name: '展开为节点' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已展开')

  dialog = await openBoard()
  await dialog.getByLabel('台词').first().fill('林晚：你到底把东西藏哪儿了？')
  await dialog.getByLabel('台词').nth(1).click()
  await dialog.getByRole('button', { name: '更新展开' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已给 1 个镜头补齐')
  for (const role of ['批量出分镜图', '批量生成视频', '批量配音']) {
    await dialog.getByRole('button', { name: role }).click()
    await expect(page.locator('.ui-toast')).toContainText('已开始生成')
    console.log(role, await page.locator('.ui-toast').innerText())
    await waitIdle(page)
  }
  const all = await elements(page)
  expect(all.filter((e) => e.status === 'failed')).toEqual([])

  // 展开时镜头已按顺序接进序列：12 段镜头 + 1 条对白 + 配乐
  const seq = await byName(page, '序列')
  const into = await edgesInto(page, seq.id)
  const shotVideos = all.filter((e) => e.nodeType === 'plein/video' && e.results > 0)
  expect(shotVideos.length).toBeGreaterThanOrEqual(6)
  expect(into.filter(([, , port]) => port === 'clips')).toHaveLength(shotVideos.length)
  expect(into.filter(([, , port]) => port === 'dialogue')).toHaveLength(1)
  expect(into.filter(([, , port]) => port === 'music')).toHaveLength(1)

  // 序列编辑器：本机 ffmpeg 没有 libass 时关掉字幕（烧字幕另在 Docker 里验收）
  await page.keyboard.press('Escape')
  await zoomTo(page, [seq.id])
  const sp = await centerOf(page, seq.id)
  await page.mouse.dblclick(sp.x, sp.y)
  const editor = page.getByRole('dialog')
  await expect(editor).toBeVisible()
  await expect(editor.getByText(`${shotVideos.length} 段`).first()).toBeVisible()
  if (!hasLibass()) {
    await editor.getByRole('checkbox', { name: '字幕', exact: true }).uncheck()
    test
      .info()
      .annotations.push({ type: '降级', description: '本机 ffmpeg 无 libass，导出未烧字幕' })
  }
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()

  await contextMenu(page, seq.id, '运行到此处')
  await waitNode(page, seq.id, 120_000)
  const out = (await page.evaluate((id) => {
    const { engine } = window.__plein
    return engine.doc.get(id)!.results!.at(-1)!.value
  }, seq.id)) as { assetId: string; mime: string }
  expect(out.mime).toBe('video/mp4')
  const meta = await (await page.request.get(`/api/assets/${out.assetId}/meta`)).json()
  // 竖屏 1080p，时长按镜头拼起来（mock 视频每段约 1 秒）
  expect([meta.width, meta.height]).toEqual([1080, 1920])
  expect(meta.duration).toBeGreaterThan(shotVideos.length * 0.5)
  test.info().annotations.push({
    type: '成片',
    description: `${meta.width}×${meta.height}，${meta.duration.toFixed(1)} 秒，${shotVideos.length} 段镜头`,
  })

  // 刷新后画布原样还在
  const before = (await elements(page)).length
  await page.reload()
  await waitEngine(page)
  await expect.poll(async () => (await elements(page)).length).toBe(before)
})
