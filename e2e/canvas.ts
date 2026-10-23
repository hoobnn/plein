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
          /** 边的底层 Y.Map：直接写边，跳过连线命令按当前模型重建 */
          edgeMap: {
            set(
              id: string,
              edge: {
                id: string
                from: [string, string]
                to: [string, string]
                order: string
              },
            ): void
          }
          worldRect(id: string): { x: number; y: number; w: number; h: number }
        }
        worldToClient(x: number, y: number): { x: number; y: number }
        zoomToFit(ids?: Iterable<string>): void
        selection: { values(): string[]; set(ids: string[]): void }
        /** 相机：平移、缩放和侧栏留出的边距 */
        camera: {
          insets: { left: number; top: number; right: number; bottom: number }
          panBy(dx: number, dy: number): void
          zoomAt(sx: number, sy: number, factor: number): void
        }
        /** 场景：元素和它的世界坐标矩形 */
        scene: {
          get(id: string): { id: string; kind: string } | undefined
          rect(id: string): { x: number; y: number; w: number; h: number } | undefined
        }
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

/** 新建项目的可选行为 */
export interface NewProjectOptions {
  /**
   * 先打开首页再进画布。
   *
   * 首页会拉一次项目列表并缓存（查询层 staleTime 10s）。少数用例要验证
   * 「列表刷新失败时仍显示旧数据」这类行为，依赖这份已经预热的缓存；
   * 默认不走首页，测试的就是刷新本身。
   */
  visitHome?: boolean
}

/**
 * 新建一个项目并进到它的第一张画布。
 *
 * 走接口建项目，不点首页的「新建项目」按钮：绝大多数用例要的是「有一张空画布可用」，
 * 不是首页那个按钮本身（测按钮的用例自己点）。接口建项目省掉首页渲染和
 * 「首页卡片放大成画布」的 View Transition，每条用例都能省下几百毫秒。
 */
export async function newProject(page: Page, options: NewProjectOptions = {}) {
  const project = await page.request.post('/api/projects', { data: {} })
  expect(project.status(), await project.text()).toBe(201)
  const { lastCanvasId } = (await project.json()) as { lastCanvasId: string | null }
  expect(lastCanvasId, '新建项目应同时建好第一张画布').toBeTruthy()
  if (options.visitHome) {
    // 首页拉一次项目列表，把列表缓存预热起来
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
  }
  await page.goto(`/#/c/${encodeURIComponent(lastCanvasId!)}`)
  await waitEngine(page)
  // 画布元素就位前不接受点击，等它真的渲染出来
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
 * 等镜头停稳：相机位置连续几帧不变，且没有正在进行的飞行动画。
 * 飞行动画（flyTo）由引擎按时间推进，等它自然结束要按动画时长猜；
 * 直接读相机的位置，连续几帧不动就是停稳了。
 */
export async function settleCamera(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((done) => {
        const engine = window.__plein.engine as Window['__plein']['engine'] & {
          flight?: unknown
        }
        const camera = engine.camera as unknown as { x: number; y: number; zoom: number }
        const at = () => `${camera.x},${camera.y},${camera.zoom}`
        let last = at()
        let same = 0
        const tick = () => {
          const now = at()
          same = now === last ? same + 1 : 0
          last = now
          // 没有飞行、位置连续几帧不变，才算停稳
          if (!engine.flight && same >= 5) done(true)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
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

/**
 * 固定尺寸编辑器不会自动避开视口；编辑操作前像用户一样把它平移回可见区域。
 * 面板里的内容可能比面板还高，指定 target 时再把它滚进面板内。
 */
export async function revealGenerator(page: Page, target?: Locator) {
  const editor = page.getByTestId('node-editor')
  await expect(editor).toBeVisible()
  // 面板跟着相机走，平移后要再确认一次仍在窗口里
  for (let attempt = 0; attempt < 3; attempt++) {
    const moved = await editor.evaluate((el) => {
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
      // 底部工具条浮在画布上，面板不能被它压住：按工具条实际高度留出位置
      const footer = document.querySelector('.plein-footer')
      const reserve = footer ? Math.max(76, footer.getBoundingClientRect().height + 16) : 76
      const dy = Math.max(12 - box.y, Math.min(0, innerHeight - reserve - box.bottom))
      if (dx || dy) engine.camera.panBy(dx, dy)
      return dx !== 0 || dy !== 0
    })
    if (!moved) break
    await page.waitForTimeout(100)
  }
  // 等面板停稳，否则点击会落在还在移动的位置上
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="node-editor"]')
    if (!el) return false
    const box = el.getBoundingClientRect()
    const last = (el as HTMLElement & { __revealTop?: number }).__revealTop
    ;(el as HTMLElement & { __revealTop?: number }).__revealTop = box.top
    return last === undefined || Math.abs(last - box.top) < 0.5
  })
  if (target) {
    await target.scrollIntoViewIfNeeded()
    // 面板比窗口还宽时，目标可能在窗口外：把它平移进来
    for (let attempt = 0; attempt < 3; attempt++) {
      const moved = await target.evaluate((el) => {
        const box = el.getBoundingClientRect()
        const engine = window.__plein.engine as Window['__plein']['engine'] & {
          camera: { panBy(x: number, y: number): void; insets: { left: number } }
        }
        // 目标要躲开左侧栏和窗口边
        const inset = engine.camera.insets.left
        const dx =
          box.left < inset
            ? inset - box.left
            : box.right > innerWidth - 12
              ? innerWidth - 12 - box.right
              : 0
        const dy =
          box.top < 12
            ? 12 - box.top
            : box.bottom > innerHeight - 12
              ? innerHeight - 12 - box.bottom
              : 0
        if (dx || dy) engine.camera.panBy(dx, dy)
        return dx !== 0 || dy !== 0
      })
      if (!moved) break
      await page.waitForTimeout(100)
    }
  }
}

/** 右键元素，点菜单项 */
export async function contextMenu(page: Page, id: string, item: string) {
  // 先取消选中：选中节点的生成器面板会浮在画布上，可能正好盖住要右键的元素
  await deselect(page)
  await settle(page, id)
  // 分组（Frame）里有子节点，右键落在中心会打到子节点上；
  // 分组自己的标题条在顶端，那里才是分组的菜单。
  const p = await page.evaluate((id) => {
    const { engine } = window.__plein
    const r = engine.doc.worldRect(id)!
    const el = engine.scene.get(id)
    const tl = engine.worldToClient(r.x, r.y)
    if (el?.kind === 'frame') return { x: tl.x + 60, y: tl.y + 8 }
    const br = engine.worldToClient(r.x + r.w, r.y + r.h)
    return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }
  }, id)
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

/**
 * 点节点编辑器里的生成按钮。
 * 生成前要等服务端把实际输入备好，按钮才会解禁；不等就点，按钮还是禁用的，
 * 请求发不出去，用例只能等到超时。
 */
export async function clickRun(page: Page, name = '生成') {
  const button = page.getByTestId('generator').getByRole('button', { name, exact: true })
  await expect(button, '生成前要等服务端备好实际输入').toBeEnabled()
  await button.click()
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
