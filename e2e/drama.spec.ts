import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import {
  byName,
  centerOf,
  contextMenu,
  addNode,
  edgesInto,
  elements,
  newProject,
  runBatch,
  waitEngine,
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

test('短剧模板：插入 → 跑骨架 → 展开 → 批量 → 导出', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await addNode(page, '短剧')
  await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')

  const board = await byName(page, '分镜（双击展开镜头）')
  await zoomTo(page, [board.id])
  await contextMenu(page, board.id, '运行到此处')
  await waitNode(page, board.id)
  // 认准这一次的提示：节点先变成成功，「运行完成」要等前端下一次查进度才弹出
  await expect(page.locator('.ui-toast')).toContainText('运行到「分镜（双击展开镜头）」运行完成')

  // 角色与场景抽取是分镜的上游，已经跑过 → 一键落成设定卡
  const cast = await byName(page, '角色与场景抽取')
  expect(cast.status).toBe('succeeded')
  await zoomTo(page, [cast.id])
  await contextMenu(page, cast.id, '生成设定卡（4）')
  await expect(page.locator('.ui-toast')).toContainText('新建 4 张设定卡')
  expect((await byName(page, '林晚')).nodeType).toBe('plein/character')
  expect((await byName(page, '老城区天台')).nodeType).toBe('plein/scene')
  expect((await byName(page, '铁盒')).nodeType).toBe('plein/prop')
  // 每张新卡配好参考图节点（定妆图、场景图、道具图）；角色按性别、年龄配上音色
  const voiceOf = (name: string) =>
    page
      .evaluate(
        (name) =>
          [...window.__plein.engine.doc.elements()].find((e) => e.name === name) as
            | { params?: { voice?: { voiceId: string } } }
            | undefined,
        name,
      )
      .then((e) => e?.params?.voice?.voiceId)
  expect(await voiceOf('林晚')).toBe('mock-female')
  expect(await voiceOf('老周')).toBe('mock-uncle')
  const portrait = await byName(page, '林晚 · 定妆图')
  expect(portrait.results).toBe(0)
  expect((await byName(page, '老城区天台 · 场景图')).results).toBe(0)
  expect((await byName(page, '铁盒 · 道具图')).results).toBe(0)

  const openBoard = async () => {
    // 先取消选中：上一步选中节点的生成器面板可能正好盖在分镜节点上
    await page.keyboard.press('Escape')
    await zoomTo(page, [board.id])
    const p = await centerOf(page, board.id)
    await page.mouse.dblclick(p.x, p.y)
    const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
    await expect(dialog).toBeVisible()
    // 详细卡片视图：批量操作区展开着，台词也在每张卡片上
    await dialog.getByRole('button', { name: '详细卡片', exact: true }).click()
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
  for (const role of ['批量出分镜图', '批量生成视频', '批量配音'])
    await runBatch(page, dialog, role)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '「分镜（双击展开镜头）」批量生成', exact: true }).first(),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  const all = await elements(page)
  expect(all.filter((e) => e.status === 'failed')).toEqual([])
  // 批量出分镜图时，镜头 @ 到的林晚、老城区天台、铁盒先出了参考图
  expect((await byName(page, '林晚 · 定妆图')).results).toBeGreaterThan(0)
  expect((await byName(page, '老城区天台 · 场景图')).results).toBeGreaterThan(0)
  expect((await byName(page, '铁盒 · 道具图')).results).toBeGreaterThan(0)

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
    await editor.getByRole('button', { name: '成片', exact: true }).click()
    const subtitles = editor.getByRole('switch', { name: '开启字幕' })
    if ((await subtitles.getAttribute('aria-checked')) === 'true') await subtitles.click()
    await expect(subtitles).toHaveAttribute('aria-checked', 'false')
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
