import { expect, type Locator, type Page } from '@playwright/test'
import type { ProductionRecord } from '../packages/doc/src/production'
import type { DeliveryRecord } from '../packages/doc/src/delivery'

/** e2e 构建在 window 上暴露的只读入口（见 apps/web/src/canvas/CanvasView.tsx），这里只声明用到的部分 */
interface RawElement {
  production?: ProductionRecord
  deliveries?: DeliveryRecord[]
  id: string
  kind: string
  name?: string
  nodeType?: string
  parentId: string | null
  assetId?: string
  adopted?: string | null
  text?: string
  params?: Record<string, unknown>
  run?: { status: string }
  results?: Array<{ id: string; runId: string; value: Record<string, unknown> }>
}
declare global {
  interface Window {
    __plein: {
      engine: {
        doc: {
          elements(): Iterable<RawElement>
          edges(): Iterable<{ from: [string, string]; to: [string, string] }>
          get(id: string): RawElement | undefined
          /** 元素底层的 Y.Map（只有 L4 用它模拟在面板里改参数） */
          mutable(id: string): { get(key: string): unknown } | undefined
          /** markdown 元素正文的 Y.Text（L4 用它换掉模板创意） */
          getText(id: string):
            | {
                length: number
                delete(i: number, n: number): void
                insert(i: number, s: string): void
              }
            | undefined
          worldRect(id: string): { x: number; y: number; w: number; h: number }
        }
        worldToClient(x: number, y: number): { x: number; y: number }
        zoomToFit(ids?: Iterable<string>): void
        selection: { values(): string[]; set(ids: string[]): void }
      }
      /** 按节点声明建节点、连线（L4 实验脚本批量搭画布用） */
      addNode(input: {
        type: string
        name: string
        params: Record<string, unknown>
        x: number
        y: number
      }): string
      connect(from: [string, string], to: [string, string]): boolean
    }
  }
}

/** 画布元素的精简视图：测试只关心种类、名字、节点类型与运行状态 */
export interface ElementView {
  id: string
  kind: string
  name?: string
  nodeType?: string
  parentId?: string | null
  status?: string
  results: number
}

/** 读当前画布的全部元素（经 e2e 构建暴露的 engine，只读） */
export function elements(page: Page): Promise<ElementView[]> {
  return page.evaluate(() => {
    const { engine } = window.__plein
    return [...engine.doc.elements()].map((el) => ({
      id: el.id,
      kind: el.kind,
      name: el.name,
      nodeType: el.nodeType,
      parentId: el.parentId ?? null,
      status: el.run?.status,
      results: el.results?.length ?? 0,
    }))
  })
}

export async function byName(page: Page, name: string) {
  const list = (await elements(page)).filter((e) => e.name === name)
  expect(list, `画布上应有且只有一个「${name}」`).toHaveLength(1)
  return list[0]!
}

/** 元素中心在屏幕上的位置（真实鼠标点在这里，由画布自己做命中） */
export async function centerOf(page: Page, id: string) {
  return page.evaluate((id) => {
    const { engine } = window.__plein
    const r = engine.doc.worldRect(id)
    return engine.worldToClient(r.x + r.w / 2, r.y + r.h / 2)
  }, id)
}

export async function waitEngine(page: Page) {
  await page.waitForFunction(() => !!window.__plein)
}

/** 从首页新建一个项目，进到它的第一张画布 */
export async function newProject(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await expect(page).toHaveURL(/#\/c\//)
  await waitEngine(page)
  // 首页卡片放大成画布走 View Transition，过渡期间点击落在过渡层上、打不到画布
  await page.waitForFunction(() => {
    const at = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
    return at?.tagName === 'CANVAS' || !!at?.closest('[aria-label="选择创作起点"]')
  })
}

/** 双击空白处打开添加菜单，搜索并选第一项 */
export async function addNode(page: Page, query: string, at = { x: 720, y: 450 }) {
  await page.mouse.dblclick(at.x, at.y)
  await page.getByPlaceholder('添加节点').fill(query)
  await page.keyboard.press('Enter')
}

/** 缩放到某些元素，保证它们在视口里能点到 */
export async function zoomTo(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    const { engine } = window.__plein
    engine.zoomToFit(ids)
  }, ids)
  await settle(page, ids[0]!)
}

/**
 * 等镜头和元素停稳：元素在屏幕上的位置和大小连续几帧不变。
 * 展开分镜、放资产等操作会自己飞到新内容，动画没结束就按坐标点，会点到别处；
 * 便签先按估算高度放置、量出正文后才收缩（顶边不动），只看位置会在收缩前取到中心
 */
export async function settle(page: Page, id: string) {
  await page.waitForFunction(
    (id) =>
      new Promise<boolean>((done) => {
        const { engine } = window.__plein
        const at = () => {
          const r = engine.doc.worldRect(id)
          const p = engine.worldToClient(r.x, r.y)
          const q = engine.worldToClient(r.x + r.w, r.y + r.h)
          return [p.x, p.y, q.x, q.y].map(Math.round).join()
        }
        let last = at()
        let same = 0
        const tick = () => {
          const now = at()
          same = now === last ? same + 1 : 0
          last = now
          if (same >= 5) done(true)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    id,
  )
}

/**
 * 取消选中，并等选中节点的生成器浮层收起：浮层会盖住画布上的元素，
 * 有时第一下 Esc 被别的弹层（关闭中的对话框、提示）接走，所以按到真的清空为止
 */
export async function deselect(page: Page) {
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Escape')
        return page.evaluate(() => window.__plein.engine.selection.values().length)
      },
      { message: '按 Esc 应取消选中' },
    )
    .toBe(0)
}

/** 单击选中元素：取消选中、镜头对准并停稳，确认落点在画布上没被浮层挡住再点 */
export async function clickElement(page: Page, id: string) {
  await deselect(page)
  await zoomTo(page, [id])
  const p = await centerOf(page, id)
  await expect
    .poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, p), {
      message: '点击落点应在画布上，没有被浮层挡住',
    })
    .toBe('CANVAS')
  await page.mouse.click(p.x, p.y)
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([id])
}

/** 固定尺寸编辑器不会自动避开视口；编辑操作前像用户一样把它平移回可见区域。 */
export async function revealGenerator(page: Page) {
  const editor = page.getByTestId('node-editor')
  await expect(editor).toBeVisible()
  await editor.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const engine = window.__plein.engine as Window['__plein']['engine'] & {
      camera: { panBy(x: number, y: number): void }
    }
    const dx =
      box.width > innerWidth - 24
        ? 12 - box.x
        : box.right > innerWidth - 12
          ? innerWidth - 12 - box.right
          : box.x < 12
            ? 12 - box.x
            : 0
    const dy = Math.max(12 - box.y, Math.min(0, innerHeight - 76 - box.bottom))
    if (dx || dy) engine.camera.panBy(dx, dy)
  })
}

/** 右键元素，点菜单项 */
export async function contextMenu(page: Page, id: string, item: string) {
  // 先取消选中：选中节点的生成器面板会浮在画布上，可能正好盖住要右键的元素
  await deselect(page)
  await settle(page, id)
  const p = await centerOf(page, id)
  await expect
    .poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, p), {
      message: '右键落点应在画布上，没有被浮层挡住',
    })
    .toBe('CANVAS')
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.getByRole('menu').getByText(item, { exact: true }).click()
}

/** 节点一侧连接点在屏幕上的位置：输入在左边中点、输出在右边中点（见 canvas-core ports.ts） */
export async function handleOf(page: Page, id: string, side: 'in' | 'out') {
  return page.evaluate(
    ([id, side]) => {
      const { engine } = window.__plein
      const r = engine.doc.worldRect(id)
      return engine.worldToClient(side === 'in' ? r.x : r.x + r.w, r.y + r.h / 2)
    },
    [id, side] as const,
  )
}

/** 等节点跑完；失败直接带出错误信息 */
export async function waitNode(page: Page, id: string, timeout = 60_000) {
  await expect
    .poll(
      async () => {
        const el = (await elements(page)).find((e) => e.id === id)
        return el?.status
      },
      { timeout, message: `节点 ${id} 应运行成功` },
    )
    .toBe('succeeded')
}

/** 连到某个元素输入口的连线：[来源元素, 来源端口, 目标端口] */
export function edgesInto(page: Page, id: string) {
  return page.evaluate((id) => {
    const { engine } = window.__plein
    return [...engine.doc.edges()]
      .filter((e) => e.to[0] === id)
      .map((e) => [e.from[0], e.from[1], e.to[1]] as [string, string, string])
  }, id)
}

/** 等所有节点都不在排队 / 运行中 */
export async function waitIdle(page: Page, timeout = 90_000) {
  await expect
    .poll(
      async () =>
        (await elements(page)).filter((e) => e.status === 'queued' || e.status === 'running')
          .length,
      { timeout, message: '节点应全部跑完' },
    )
    .toBe(0)
}

/** 画布上的全部任务 id 与状态（任务面板接口，最新的在前） */
async function jobs(page: Page) {
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!
  const list = (await page.evaluate(
    (url) => fetch(url).then((r) => r.json()),
    `/api/canvases/${canvas}/jobs`,
  )) as { jobs: Array<{ id: string; status: string }> }
  return list.jobs
}

/**
 * 分镜表的「节点与批量操作」在表格视图里是折叠的，展开为节点、批量生成这些
 * 按钮都收在里面。要用它们先把这块展开。
 */
export async function openStoryboardActions(dialog: Locator) {
  const section = dialog.locator('details').first()
  if ((await section.getAttribute('open')) === null) await section.locator('summary').click()
  await expect(dialog.getByRole('toolbar', { name: '分镜批量操作' })).toBeVisible()
}

/** 分镜表的逐镜头字段（分镜图提示词、台词等）在详细卡片视图上，表格视图没有这些输入框。 */
export async function showStoryboardCards(dialog: Locator) {
  await dialog.getByRole('button', { name: '详细卡片', exact: true }).click()
  await expect(dialog.getByRole('article').first()).toBeVisible()
}

/**
 * 点分镜表里的批量按钮并等这一批跑完。视频、配音是按节点逐个提交的，提示比提交先出来，
 * 上一批的「已开始生成」提示也可能还在：只等提示和节点空闲会在任务还没提交时就往下走。
 * 这里按提示里的个数等新任务都提交到服务端、全部结束，再等画布同步到空闲
 */
export async function runBatch(page: Page, dialog: Locator, label: string, timeout = 90_000) {
  const noun = { 批量出分镜图: '分镜图', 批量生成视频: '视频', 批量配音: '配音' }[label]
  if (!noun) throw new Error(`不认识的批量按钮：${label}`)
  const seen = new Set((await jobs(page)).map((j) => j.id))
  await dialog.getByRole('button', { name: label }).click()
  const started = await confirmBatchChecklist(page)
  await expect
    .poll(
      async () => {
        const fresh = (await jobs(page)).filter((j) => !seen.has(j.id))
        const done = fresh.filter((j) => !['queued', 'running'].includes(j.status))
        return fresh.length >= started && done.length === fresh.length
      },
      { timeout, message: `${noun}应全部提交并跑完` },
    )
    .toBe(true)
  await waitIdle(page, timeout)
  return started
}

/** 批量按钮先只预检；测试也必须显式审阅和确认，不能绕过清单入口。 */
export async function confirmBatchChecklist(page: Page) {
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  await expect(checklist).toBeVisible()
  const confirm = checklist.getByRole('button', { name: '确认并开始生成', exact: true })
  await expect(confirm).toBeEnabled()
  const response = page.waitForResponse(
    (res) => res.url().endsWith('/storyboard-batch/commit') && res.request().method() === 'POST',
  )
  await confirm.click()
  const result = await response
  expect(result.status(), await result.text()).toBe(202)
  const { total } = (await result.json()) as { total: number }
  await expect(checklist).toBeHidden()
  return total
}
