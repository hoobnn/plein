import { describe, expect, it } from 'vite-plus/test'
import { editorViewport } from './editorViewport'

describe('便签可见编辑窗口', () => {
  const viewport = { x: 0, y: 0, w: 1440, h: 900 }
  const insets = { left: 280, top: 64, right: 12, bottom: 64 }
  it('完整可见的短便签保留原始编辑区域', () => {
    expect(editorViewport({ x: 500, y: 120, w: 360, h: 100 }, viewport, insets, 1)).toEqual({
      x: 0,
      y: 0,
      w: 360,
      h: 100,
    })
  })
  it('长便签的编辑高度避开底部工具栏', () => {
    expect(editorViewport({ x: 500, y: 120, w: 360, h: 2000 }, viewport, insets, 1)).toEqual({
      x: 0,
      y: 0,
      w: 360,
      h: 716,
    })
  })
  it('相机未配置垂直边距时也保留导航与工具条空间', () => {
    expect(
      editorViewport(
        { x: 500, y: -240, w: 360, h: 2000 },
        viewport,
        { left: 0, top: 0, right: 0, bottom: 0 },
        1,
      ),
    ).toEqual({ x: 0, y: 304, w: 360, h: 772 })
  })
  it('顶部移出视口时从可见部分开始显示编辑器', () => {
    expect(editorViewport({ x: 500, y: -240, w: 360, h: 2000 }, viewport, insets, 1)).toEqual({
      x: 0,
      y: 304,
      w: 360,
      h: 772,
    })
  })
  it('将屏幕边距按缩放换算，同时处理左右裁剪', () => {
    expect(
      editorViewport(
        { x: 100, y: 0, w: 800, h: 1000 },
        { x: 10, y: 20, w: 720, h: 450 },
        insets,
        2,
      ),
    ).toEqual({ x: 50, y: 52, w: 574, h: 386 })
  })
  it('节点完全离开安全视口或没有面积时不提供编辑窗口', () => {
    expect(editorViewport({ x: 2000, y: 0, w: 360, h: 100 }, viewport, insets, 1)).toBe(null)
    expect(editorViewport({ x: 500, y: 120, w: 0, h: 100 }, viewport, insets, 1)).toBe(null)
  })
})
