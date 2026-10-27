import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  byName,
  centerOf,
  clickElement,
  contextMenu,
  deselect,
  newProject,
  openStoryboardActions,
  runBatch,
  settle,
  showStoryboardCards,
  waitIdle,
  waitNode,
  zoomTo,
} from './canvas'

/** 每个镜头展开出来的节点现在采用的结果和候选数，以及序列的剪辑参数 */
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const doc = window.__plein.engine.doc
    const all = [...doc.elements()]
    const board = all.find((e) => e.name === '分镜（双击展开镜头）')!
    const shots = (board.params!.shots as Array<{ id: string }>).map((s) => s.id)
    type Raw = (typeof all)[number] & {
      adopted?: string
      results?: Array<{ id: string }>
    }
    const nodes = (shotId: string) =>
      Object.fromEntries(
        all
          .filter((e) => (e.params?.source as { shot?: string } | undefined)?.shot === shotId)
          .map((e) => {
            const el = e as Raw
            const role = (e.params!.source as { role: string }).role
            const prompt = String(e.params?.prompt ?? e.params?.text ?? '')
            return [
              role,
              {
                id: e.id,
                adopted: el.adopted ?? el.results?.[0]?.id,
                results: el.results?.length ?? 0,
                prompt,
              },
            ]
          }),
      )
    const seq = all.find((e) => e.nodeType === 'plein/sequence')!
    return { shots: shots.map(nodes), clips: JSON.stringify(seq.params?.clips ?? []) }
  })

test(
  '六镜头项目改第三镜头：查看影响、只重做勾选的分支，撤销不删候选',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    await addNode(page, '短剧')
    await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')

    const board = await byName(page, '分镜（双击展开镜头）')
    await zoomTo(page, [board.id])
    await contextMenu(page, board.id, '运行到此处')
    await waitNode(page, board.id)
    await expect(page.locator('.ui-toast')).toContainText('运行到「分镜（双击展开镜头）」运行完成')
    // 设定卡带音色，配音节点才有音色可用
    const cast = await byName(page, '角色与场景抽取')
    await zoomTo(page, [cast.id])
    await contextMenu(page, cast.id, '生成设定卡（4）')
    await expect(page.locator('.ui-toast')).toContainText('新建 4 张设定卡')

    const openBoard = async () => {
      await deselect(page)
      await zoomTo(page, [board.id])
      // 先选中再双击：选中后节点编辑器展开在卡片下方，画布布局跟着变，
      // 原来的坐标就偏了。选中后等位置稳住再重新取一次坐标双击。
      await clickElement(page, board.id)
      await settle(page, board.id)
      const p = await centerOf(page, board.id)
      await page.mouse.dblclick(p.x, p.y)
      const dialog = page.getByRole('dialog', { name: '分镜表' })
      await expect(dialog).toBeVisible()
      return dialog
    }

    // 只留六个镜头，第一和第三镜头写上台词，展开
    let dialog = await openBoard()
    const rows = dialog.getByRole('button', { name: /^删除镜头 \d+$/ })
    while ((await rows.count()) > 6) await rows.last().click()
    await expect(rows).toHaveCount(6)
    const durations = () =>
      dialog
        .getByLabel('时长')
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    const originalDurations = await durations()
    await dialog.getByLabel('台词').nth(0).fill('林晚：雨这么大，谁会来天台？')
    await dialog.getByLabel('台词').nth(0).blur()
    await dialog.getByLabel('台词').nth(2).fill('林晚：铁盒是谁放在这儿的？')
    await dialog.getByLabel('台词').nth(2).blur()
    expect(await durations()).toEqual(originalDurations)
    // 批量操作收在折叠区里，先展开再点
    await openStoryboardActions(dialog)
    await dialog.getByRole('button', { name: '展开为节点' }).click()
    await expect(page.locator('.ui-toast')).toContainText('已展开 6 个镜头')

    dialog = await openBoard()
    // 批量按钮收在折叠区里，每次打开分镜表都要重新展开
    await openStoryboardActions(dialog)
    for (const role of ['批量出分镜图', '批量生成视频', '批量配音'])
      await runBatch(page, dialog, role)
    const before = await snapshot(page)
    expect(before.shots).toHaveLength(6)
    for (const s of before.shots) expect(s.image!.results).toBe(1)
    expect(before.shots[2]!.speech!.results).toBe(1)

    // 改第三镜头的台词和分镜图提示词，从分镜表进「查看影响」
    dialog = await openBoard()
    // 逐镜头的台词和分镜图提示词在详细卡片视图上，表格视图没有这些输入框
    await showStoryboardCards(dialog)
    await dialog.getByLabel('台词').nth(2).fill('林晚：这盒子不是我的。')
    await dialog.getByLabel('台词').nth(2).blur()
    await dialog.getByLabel('分镜图提示词').nth(2).fill('铁盒特写，雨水顺着锁扣往下流')
    await dialog.getByLabel('分镜图提示词').nth(2).blur()
    await expect(dialog.getByLabel('分镜图提示词').nth(2)).toHaveValue(
      '铁盒特写，雨水顺着锁扣往下流',
    )
    expect(await durations()).toEqual(originalDurations)
    await dialog.getByRole('button', { name: '查看影响' }).click()
    const impact = page.getByRole('dialog', { name: '查看影响' })
    await expect(impact).toBeVisible()

    // 分镜表的改动还没同步到节点：先看差异，按现有同步合同写进去
    await expect(impact.getByText('分镜表有没同步的改动')).toBeVisible()
    const plan = impact.locator('section').filter({
      has: page.getByRole('heading', { name: '分镜表有没同步的改动', exact: true }),
    })
    await expect(plan.getByRole('listitem')).toHaveCount(1)
    await plan
      .getByRole('listitem')
      .filter({ has: page.getByText('镜头 03', { exact: true }) })
      .getByRole('button', { name: '查看差异', exact: true })
      .click()
    const diff = page.getByRole('dialog', { name: '计划差异' })
    await expect(diff.getByText('镜头 03', { exact: true })).toBeVisible()
    await expect(diff.getByText('计划已改', { exact: true })).toHaveCount(2)
    await diff.getByRole('button', { name: '同步计划改动' }).click()
    await expect(page.locator('.ui-toast')).toContainText('已把计划同步到 2 个节点')
    await page.keyboard.press('Escape')
    await expect(diff).toBeHidden()

    // 只有第三镜头受影响：配音、镜头图建议重做，视频是间接的、建议保留
    const shot3 = impact.locator('section', { hasText: '镜头 03' })
    await expect(shot3.getByText('台词改了')).toBeVisible()
    await expect(shot3.getByText('建议保留')).toBeVisible()
    await expect(impact.locator('section', { hasText: '镜头 01' })).toHaveCount(0)
    await expect(impact.getByText('价格未知')).toBeVisible()

    // 先选「只改配音 / 字幕」，再自己勾上镜头图
    // 同步回推等文档变化会让面板短暂重新分析并禁用按钮，点击恰好落在这一瞬会被吞掉，按结果重试
    await expect(async () => {
      await impact.getByRole('button', { name: '只改配音 / 字幕' }).click({ timeout: 1_000 })
      await expect(shot3.getByRole('checkbox', { name: '重做镜头图' })).not.toBeChecked({
        timeout: 1_000,
      })
    }).toPass()
    await expect(shot3.getByRole('checkbox', { name: '重做配音' })).toBeChecked()
    await shot3.getByRole('checkbox', { name: '重做镜头图' }).check()
    await expect(shot3.getByRole('checkbox', { name: '重做视频' })).not.toBeChecked()
    await expect(async () => {
      if (await impact.isVisible())
        await impact.getByRole('button', { name: '重做选中的 2 个' }).click({ timeout: 1_000 })
      await expect(impact).toBeHidden({ timeout: 1_000 })
    }).toPass()
    await expect(page.locator('.ui-toast')).toContainText('重做受影响的结果运行完成：2 个生成')
    await waitIdle(page)

    // 其余五个镜头的采用结果、配音和剪辑参数不变；第三镜头的视频也没动
    const after = await snapshot(page)
    expect(after.clips).toBe(before.clips)
    for (const i of [0, 1, 3, 4, 5]) expect(after.shots[i]).toEqual(before.shots[i])
    expect(after.shots[2]!.video).toEqual(before.shots[2]!.video)
    expect(after.shots[2]!.image!.results).toBe(2)
    expect(after.shots[2]!.speech!.results).toBe(2)
    expect(after.shots[2]!.image!.adopted).not.toBe(before.shots[2]!.image!.adopted)

    // 视频的首帧换了：确认先保留原视频，决定留在记录里
    await page.getByRole('button', { name: '查看影响' }).click()
    await expect(impact).toBeVisible()
    const video = shot3.locator('li', { hasText: '视频' })
    await video.getByRole('button', { name: '保留', exact: true }).click()
    await expect(page.locator('.ui-toast')).toContainText('已保留 1 个结果')
    await expect(video.getByText(/^已保留/)).toBeVisible()
    await expect(impact.getByText('保留记录（1）')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(impact).toBeHidden()

    // 撤销同步：节点参数回到改之前，已经生成的候选一个都不少，还能直接沿用旧候选
    await deselect(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(async () => (await snapshot(page)).shots[2]!.image!.prompt)
      .toBe(before.shots[2]!.image!.prompt)
    const undone = await snapshot(page)
    expect(undone.shots[2]!.image!.results).toBe(2)
    expect(undone.shots[2]!.speech!.results).toBe(2)
    await page.getByRole('button', { name: '查看影响' }).click()
    await expect(shot3.getByText('可沿用已有候选').first()).toBeVisible()
  },
)
