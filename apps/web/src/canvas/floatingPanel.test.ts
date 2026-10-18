import { describe, expect, it } from 'vite-plus/test'
import { fitFloatingPanel, fitFrameToolbar } from './floatingPanel'

describe('浮动操作区避让侧栏与任务面板', () => {
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
      fitFrameToolbar(
        { x: 464, y: 408 },
        { width: 512, height: 72 },
        { width: 900, left: 0, right: 372 },
      ),
    ).toEqual({ right: 380, top: 328, maxWidth: 512 })
    expect(
      fitFrameToolbar(
        { x: 1004, y: 64 },
        { width: 614, height: 40 },
        { width: 1440, left: 284, right: 372 },
      ),
    ).toEqual({ right: 436, top: 64, maxWidth: 768 })
  })
})
