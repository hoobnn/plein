/**
 * 发布指标「局部返工操作数」：固定六镜头案例，从改第三镜头到替换结果完成，
 * 记录用户操作数、付费提交数和其他镜头有没有被动到。
 *
 *   pnpm --filter @plein/web exec vp build --mode e2e --outDir dist-e2e
 *   pnpm exec playwright test -c e2e/playwright.bench.config.ts
 *
 * 操作只计用户意图上的一步：点按钮 / 菜单项、填一个输入框、按一次 Esc；
 * 镜头移动（缩放到元素）和等待不计。每条路径的目标都是第三镜头的分镜图、配音、视频换成新结果
 * （「推荐默认」那条除外，见名字），其余五个镜头不变。
 */
import { expect, type Page, test } from '@playwright/test'
import {
  addNode,
  byName,
  centerOf,
  contextMenu,
  deselect,
  newProject,
  runBatch,
  waitIdle,
  waitNode,
  zoomTo,
} from '../canvas'

type Role = 'image' | 'video' | 'speech'
interface ShotNode {
  id: string
  adopted?: string
  results: number
}

/** 执行一步用户操作并计数；右键加点菜单项这类组合传 steps */
type Op = <T>(fn: () => Promise<T>, steps?: number) => Promise<T>

const BOARD = '分镜（双击展开镜头）'
const PAID = ['plein/image', 'plein/video', 'plein/speech']

/** 每个镜头展开出来的节点现在采用的结果，以及序列的剪辑参数 */
const snapshot = (page: Page) =>
  page.evaluate((BOARD) => {
    const doc = window.__plein.engine.doc
    const all = [...doc.elements()]
    const board = all.find((e) => e.name === BOARD)!
    const shots = (board.params!.shots as Array<{ id: string }>).map((s) => s.id)
    type Raw = (typeof all)[number] & { adopted?: string; results?: Array<{ id: string }> }
    const nodes = (shotId: string) =>
      Object.fromEntries(
        all
          .filter((e) => (e.params?.source as { shot?: string } | undefined)?.shot === shotId)
          .map((e) => {
            const el = e as Raw
            return [
              (e.params!.source as { role: string }).role,
              {
                id: e.id,
                adopted: el.adopted ?? el.results?.[0]?.id,
                results: el.results?.length ?? 0,
              },
            ]
          }),
      ) as Record<string, ShotNode>
    const seq = all.find((e) => e.nodeType === 'plein/sequence')!
    return { shots: shots.map(nodes), clips: JSON.stringify(seq.params?.clips ?? []) }
  }, BOARD)

/** 某个时刻之后新建的任务，按节点类型计数 */
async function jobsSince(page: Page, since: number) {
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!
  const list = (await page.evaluate(
    (url) => fetch(url).then((r) => r.json()),
    `/api/canvases/${canvas}/jobs`,
  )) as { jobs: Array<{ nodeType: string; createdAt: number; status: string }> }
  const count: Record<string, number> = {}
  for (const j of list.jobs)
    if (j.createdAt >= since) count[j.nodeType] = (count[j.nodeType] ?? 0) + 1
  return count
}

/** 搭好六镜头项目并跑完分镜图、视频、配音（不计入指标） */
async function sixShots(page: Page) {
  await newProject(page)
  await addNode(page, '短剧')
  await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')
  const board = await byName(page, BOARD)
  await zoomTo(page, [board.id])
  await contextMenu(page, board.id, '运行到此处')
  await waitNode(page, board.id)
  await expect(page.locator('.ui-toast')).toContainText(`运行到「${BOARD}」运行完成`)
  const cast = await byName(page, '角色与场景抽取')
  await zoomTo(page, [cast.id])
  await contextMenu(page, cast.id, '生成设定卡（4）')
  await expect(page.locator('.ui-toast')).toContainText('新建 4 张设定卡')

  const openBoard = async () => {
    await deselect(page)
    await zoomTo(page, [board.id])
    const p = await centerOf(page, board.id)
    await page.mouse.dblclick(p.x, p.y)
    const dialog = page.getByRole('dialog', { name: '分镜表' })
    await expect(dialog).toBeVisible()
    return dialog
  }
  let dialog = await openBoard()
  const rows = dialog.getByRole('button', { name: /^删除镜头 \d+$/ })
  while ((await rows.count()) > 6) await rows.last().click()
  await dialog.getByLabel('台词').nth(0).fill('林晚：雨这么大，谁会来天台？')
  await dialog.getByLabel('台词').nth(2).fill('林晚：铁盒是谁放在这儿的？')
  await dialog.getByLabel('时长').first().click()
  await dialog.getByRole('button', { name: '展开为节点' }).click()
  await expect(page.locator('.ui-toast')).toContainText('已展开 6 个镜头')
  dialog = await openBoard()
  for (const role of ['批量出分镜图', '批量生成视频', '批量配音'])
    await runBatch(page, dialog, role)
  await page.keyboard.press('Escape')
  await deselect(page)
  return { board: board.id, openBoard }
}

/** 一条返工路径：ops 记用户操作 */
async function measure(
  page: Page,
  name: string,
  rework: (ctx: {
    op: Op
    openBoard: () => Promise<ReturnType<Page['getByRole']>>
    before: Awaited<ReturnType<typeof snapshot>>
  }) => Promise<void>,
) {
  const { openBoard } = await sixShots(page)
  const before = await snapshot(page)
  const t0 = Date.now()
  let ops = 0
  const op: Op = async (fn, steps = 1) => {
    ops += steps
    return fn()
  }
  await rework({ op, openBoard: () => op(openBoard), before })
  await waitIdle(page)
  const seconds = (Date.now() - t0) / 1000
  // 结果经文档同步到页面有一点延迟：等快照连续两次一样再记
  let after = await snapshot(page)
  for (;;) {
    await page.waitForTimeout(500)
    const again = await snapshot(page)
    if (JSON.stringify(again) === JSON.stringify(after)) break
    after = again
  }
  const jobs = await jobsSince(page, t0)
  const paid = PAID.reduce((n, t) => n + (jobs[t] ?? 0), 0)
  const touched = [0, 1, 3, 4, 5].filter(
    (i) => JSON.stringify(after.shots[i]) !== JSON.stringify(before.shots[i]),
  ).length
  const replaced = (['image', 'speech', 'video'] as Role[]).filter(
    (r) => after.shots[2]![r]?.adopted !== before.shots[2]![r]?.adopted,
  )
  const row = { name, ops, paid, jobs, touched, replaced: replaced.join('/'), seconds }
  console.log(`BENCH ${JSON.stringify(row)}`)
  return row
}

/** 在分镜表里改第三镜头的台词和分镜图提示词（2 步，不含打开分镜表） */
async function editShot3(dialog: ReturnType<Page['getByRole']>, op: Op) {
  await op(() => dialog.getByLabel('台词').nth(2).fill('林晚：这盒子不是我的。'))
  await op(() => dialog.getByLabel('分镜图提示词').nth(2).fill('铁盒特写，雨水顺着锁扣往下流'))
  // 让输入框失焦提交（用户接着点别的按钮时自然发生，不计）
  await dialog.getByLabel('时长').first().click()
}

/** 分镜表里「查看差异 → 同步计划改动 → 关掉差异」 */
async function syncPlan(page: Page, op: Op) {
  const diff = page.getByRole('dialog', { name: '计划差异' })
  await op(() => diff.getByRole('button', { name: '同步计划改动' }).click())
  await expect(page.locator('.ui-toast')).toContainText('已把计划同步到')
  await op(() => page.keyboard.press('Escape'))
  await expect(diff).toBeHidden()
}

test.describe.configure({ mode: 'serial' })

test('分镜表选中第三镜头后批量重跑', async ({ page }) => {
  const row = await measure(page, '分镜表选中第三镜头后批量按钮', async ({ op, openBoard }) => {
    const dialog = await openBoard()
    await editShot3(dialog, op)
    await op(() => dialog.getByRole('button', { name: /^查看差异/ }).click())
    await syncPlan(page, op)
    await op(() => dialog.getByRole('checkbox', { name: '选择镜头 3', exact: true }).check())
    for (const role of ['批量出分镜图', '批量生成视频', '批量配音'])
      await op(() => runBatch(page, dialog, role))
  })
  expect(row.replaced).toContain('image')
  expect(row.touched).toBe(0)
})

test('右键只跑第三镜头', async ({ page }) => {
  const row = await measure(page, '右键运行下游 + 生成配音', async ({ op, openBoard, before }) => {
    const dialog = await openBoard()
    await editShot3(dialog, op)
    await op(() => dialog.getByRole('button', { name: /^查看差异/ }).click())
    await syncPlan(page, op)
    await op(() => page.keyboard.press('Escape'))
    await expect(dialog).toBeHidden()
    const shot = before.shots[2]!
    // 右键 + 点菜单项算两步
    await zoomTo(page, [shot.image!.id])
    await op(() => contextMenu(page, shot.image!.id, '运行下游'), 2)
    await waitIdle(page)
    await zoomTo(page, [shot.speech!.id])
    await op(() => contextMenu(page, shot.speech!.id, '生成'), 2)
  })
  expect(row.replaced).toContain('image')
})

for (const keepVideo of [false, true]) {
  test(`查看影响${keepVideo ? '（推荐默认，保留视频）' : '（三项都重做）'}`, async ({ page }) => {
    const row = await measure(
      page,
      keepVideo ? '查看影响·推荐默认' : '查看影响·三项重做',
      async ({ op, openBoard }) => {
        const dialog = await openBoard()
        test.skip(
          (await dialog.getByRole('button', { name: '查看影响' }).count()) === 0,
          '基线没有查看影响',
        )
        await editShot3(dialog, op)
        await op(() => dialog.getByRole('button', { name: '查看影响' }).click())
        const impact = page.getByRole('dialog', { name: '查看影响' })
        await expect(impact).toBeVisible()
        await op(() => impact.getByRole('button', { name: '查看差异' }).click())
        await syncPlan(page, op)
        // 面板在文档变化后停 0.8 秒再重新分析，等新的建议出来再勾
        await expect(impact.getByText('分镜表有没同步的改动')).toBeHidden()
        await page.waitForTimeout(1500)
        const shot3 = impact.locator('section', { hasText: '镜头 03' })
        for (const name of ['重做镜头图', '重做配音', ...(keepVideo ? [] : ['重做视频'])]) {
          const box = shot3.getByRole('checkbox', { name })
          if (!(await box.isChecked())) await op(() => box.check())
        }
        await op(() => impact.getByRole('button', { name: /^重做选中的 \d+ 个$/ }).click())
        await expect(impact).toBeHidden()
      },
    )
    expect(row.replaced).toContain('image')
  })
}
