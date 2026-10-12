import { expect, type Page } from '@playwright/test'

/** e2e 构建在 window 上暴露的只读入口（见 apps/web/src/canvas/CanvasView.tsx），这里只声明用到的部分 */
interface RawElement {
  id: string
  kind: string
  name?: string
  nodeType?: string
  parentId: string | null
  assetId?: string
  run?: { status: string }
  results?: Array<{ value: Record<string, unknown> }>
}
declare global {
  interface Window {
    __plein: {
      engine: {
        doc: {
          elements(): Iterable<RawElement>
          edges(): Iterable<{ from: [string, string]; to: [string, string] }>
          get(id: string): RawElement | undefined
          worldRect(id: string): { x: number; y: number; w: number; h: number }
        }
        worldToClient(x: number, y: number): { x: number; y: number }
        zoomToFit(ids?: Iterable<string>): void
      }
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

/** 元素标题栏附近（Frame 中间是空白，点左上角内侧才命中 Frame 本身） */
export async function cornerOf(page: Page, id: string) {
  return page.evaluate((id) => {
    const { engine } = window.__plein
    const r = engine.doc.worldRect(id)
    return engine.worldToClient(r.x + 12, r.y + 12)
  }, id)
}

export async function waitEngine(page: Page) {
  await page.waitForFunction(() => !!window.__plein)
}

/** 缩放到某些元素，保证它们在视口里能点到 */
export async function zoomTo(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    const { engine } = window.__plein
    engine.zoomToFit(ids)
  }, ids)
  await page.waitForTimeout(300)
}

/** 右键元素，点菜单项 */
export async function contextMenu(page: Page, id: string, item: string) {
  const p = await centerOf(page, id)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.getByRole('menu').getByText(item, { exact: true }).click()
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
