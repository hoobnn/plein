import { describe, expect, it } from 'vite-plus/test'
import {
  canvasBottomSpace,
  fitCanvasToolbar,
  fitFloatingPanel,
  placeGeneratorPanel,
} from './floatingPanel'

describe('浮动操作区避让侧栏与任务面板', () => {
  it('底部空间按实际画布宽度计算，侧栏展开后也不能盖住生成器或快捷键', () => {
    expect(canvasBottomSpace(320, 0)).toEqual({ mascot: 64, generator: 128 })
    expect(canvasBottomSpace(390, 0)).toEqual({ mascot: 8, generator: 64 })
    expect(canvasBottomSpace(639, 284)).toEqual({ mascot: 64, generator: 128 })
    expect(canvasBottomSpace(664, 284)).toEqual({ mascot: 128, generator: 192 })
    expect(canvasBottomSpace(640, 284)).toEqual({ mascot: 176, generator: 240 })
    expect(canvasBottomSpace(700, 284)).toEqual({ mascot: 128, generator: 192 })
    expect(canvasBottomSpace(1440, 480)).toEqual({ mascot: 8, generator: 64 })
  })
  it('右侧任务面板挡住原居中位置时，把整个生成器移进剩余区域', () => {
    expect(fitFloatingPanel(862, 600, 292, 1060)).toEqual({ left: 460, width: 600 })
  })
  it('侧栏暂时收起的窄窗口中，生成器缩到可用宽度且保持两边间距', () => {
    expect(fitFloatingPanel(450, 600, 8, 520)).toEqual({ left: 8, width: 512 })
  })
  it('分组操作条跟随右边缘，但不会穿过任一侧面板', () => {
    expect(fitFloatingPanel(1400, 620, 292, 1060, 'right')).toEqual({ left: 440, width: 620 })
    expect(fitFloatingPanel(300, 620, 292, 1060, 'right')).toEqual({ left: 292, width: 620 })
  })
  it('空间足够时保留锚点和原宽度，极窄区域仍返回正宽度', () => {
    expect(fitFloatingPanel(600, 400, 292, 1060)).toEqual({ left: 400, width: 400 })
    expect(fitFloatingPanel(600, 400, 292, 1060, 'right')).toEqual({ left: 292, width: 400 })
    expect(fitFloatingPanel(20, 600, 8, 8)).toEqual({ left: 8, width: 1 })
  })
  it('分组工具条换行增高后仍留在组标题上方，并避开顶栏', () => {
    expect(
      fitCanvasToolbar(
        { x: 464, y: 408 },
        { width: 512, height: 72 },
        { width: 900, left: 0, right: 372 },
      ),
    ).toEqual({ right: 380, top: 328, maxWidth: 512 })
    expect(
      fitCanvasToolbar(
        { x: 1004, y: 64 },
        { width: 614, height: 40 },
        { width: 1440, left: 284, right: 372 },
      ),
    ).toEqual({ right: 436, top: 64, maxWidth: 768 })
  })
  it('多选工具条居中锚定时仍让开两侧面板，并按换行高度放在选区标题上方', () => {
    expect(
      fitCanvasToolbar(
        { x: 264, y: 350 },
        { width: 700, height: 72 },
        { width: 900, left: 0, right: 372 },
        'center',
      ),
    ).toEqual({ right: 380, top: 270, maxWidth: 512 })
  })
})

describe('节点生成面板的放置', () => {
  const bounds = { left: 297, top: 64, right: 1268, bottom: 736 }
  const rect = (left: number, top: number, w: number, h: number) => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
  })

  it('下方放得下就放下方，不动相机', () => {
    const p = placeGeneratorPanel({
      node: rect(500, 150, 400, 150),
      bounds,
      width: 960,
      height: 600,
    })
    expect(p.placement).toBe('below')
    expect(p.top).toBe(312)
    expect(p.height).toBe(424)
    expect(p.pan).toEqual({ x: 0, y: 0 })
  })
  it('下方不足最小可用高度时改放上方，并让开节点标签', () => {
    const p = placeGeneratorPanel({
      node: rect(500, 520, 400, 100),
      bounds,
      width: 960,
      height: 600,
    })
    expect(p.placement).toBe('above')
    expect(p.top + p.height).toBe(520 - 32)
    expect(p.pan).toEqual({ x: 0, y: 0 })
  })
  const shift = (r: ReturnType<typeof rect>, pan: { x: number; y: number }) => ({
    left: r.left + pan.x,
    right: r.right + pan.x,
    top: r.top + pan.y,
    bottom: r.bottom + pan.y,
  })
  it('上下都放不下时建议平移相机：平移后面板回到下方并拿到尽量多的高度', () => {
    const node = rect(500, 246, 372, 209)
    const p = placeGeneratorPanel({ node, bounds, width: 960, height: 600 })
    expect(p.pan.x).toBe(0)
    expect(p.pan.y).toBeLessThan(0)
    // 节点顶边不越过标签位置
    expect(246 + p.pan.y).toBeGreaterThanOrEqual(64 + 32)
    const after = placeGeneratorPanel({ node: shift(node, p.pan), bounds, width: 960, height: 600 })
    expect(after.placement).toBe('below')
    expect(after.pan).toEqual({ x: 0, y: 0 })
    expect(after.top + after.height).toBeLessThanOrEqual(bounds.bottom)
    expect(after.height).toBeGreaterThanOrEqual(400)
  })
  it('相机不平移时面板贴着可用区域底边，仍避开输出端口，不会被带出窗口', () => {
    const node = rect(500, 246, 372, 209)
    const p = placeGeneratorPanel({ node, bounds, width: 960, height: 600 })
    expect(p.placement).toBe('overlap')
    expect(p.top + p.height).toBe(bounds.bottom)
    expect(p.top).toBeGreaterThanOrEqual((246 + 455) / 2 + 16)
    expect(p.height).toBeGreaterThanOrEqual(160)
  })
  it('节点太高无法与最小高度的面板同屏时，平移后面板压住节点下半部并留出输出端口', () => {
    const node = rect(500, 150, 380, 420)
    const tight = { ...bounds, bottom: 656 }
    const p = placeGeneratorPanel({ node, bounds: tight, width: 960, height: 600 })
    const after = placeGeneratorPanel({
      node: shift(node, p.pan),
      bounds: tight,
      width: 960,
      height: 600,
    })
    expect(after.placement).toBe('overlap')
    const mid = (node.top + node.bottom) / 2 + p.pan.y
    expect(after.top).toBeGreaterThanOrEqual(mid + 16)
    expect(after.top + after.height).toBe(656)
    expect(after.height).toBeGreaterThanOrEqual(400)
  })
  it('窗口矮到放不下最小高度时，平移不把节点推出可见区域', () => {
    const short = { ...bounds, bottom: 256 }
    const node = rect(500, 120, 300, 100)
    const p = placeGeneratorPanel({ node, bounds: short, width: 960, height: 600 })
    expect((node.top + node.bottom) / 2 + p.pan.y).toBeGreaterThanOrEqual(64 + 32)
    const after = placeGeneratorPanel({
      node: shift(node, p.pan),
      bounds: short,
      width: 960,
      height: 600,
    })
    expect(after.top + after.height).toBeLessThanOrEqual(256)
  })
  it('节点落在右侧边缘时平移进可见宽度，面板宽度按可用宽度收', () => {
    const p = placeGeneratorPanel({
      node: rect(1200, 200, 300, 200),
      bounds,
      width: 960,
      height: 440,
    })
    expect(p.pan.x).toBe(1268 - 1500)
    expect(p.width).toBe(960)
    expect(p.left + p.width).toBeLessThanOrEqual(1268)
    const narrow = placeGeneratorPanel({
      node: rect(400, 200, 300, 200),
      bounds: { ...bounds, right: 800 },
      width: 960,
      height: 440,
    })
    expect(narrow.width).toBe(800 - 297)
    expect(narrow.left).toBe(297)
  })
  it('节点藏在侧栏后面时平移到左边距，比可见区域还宽的节点不横向平移', () => {
    expect(
      placeGeneratorPanel({ node: rect(100, 200, 300, 200), bounds, width: 600, height: 300 }).pan
        .x,
    ).toBe(197)
    expect(
      placeGeneratorPanel({ node: rect(100, 200, 1500, 200), bounds, width: 600, height: 300 }).pan
        .x,
    ).toBe(0)
  })
  it('小面板（高度低于最小可用高度）按自身高度判断是否放得下', () => {
    const p = placeGeneratorPanel({
      node: rect(500, 520, 300, 100),
      bounds,
      width: 560,
      height: 96,
    })
    expect(p.placement).toBe('below')
    expect(p.height).toBe(96)
  })
})
