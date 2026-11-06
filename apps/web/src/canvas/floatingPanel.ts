/** 把浮动面板放进两侧遮挡之间；anchor 是元素中点或右边缘，均为屏幕坐标。 */
export function fitFloatingPanel(
  anchor: number,
  preferredWidth: number,
  left: number,
  right: number,
  align: 'center' | 'right' = 'center',
) {
  const width = Math.max(1, Math.min(preferredWidth, right - left))
  const desired = anchor - (align === 'right' ? width : width / 2)
  return { width, left: Math.max(left, Math.min(desired, right - width)) }
}

/** 画布工具条可换行：用实际高度避开目标，并限制在两侧面板之间。 */
export function fitCanvasToolbar(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; left: number; right: number },
  align: 'center' | 'right' = 'right',
) {
  const left = viewport.left + 8
  const right = viewport.width - viewport.right - 8
  const panel = fitFloatingPanel(anchor.x, size.width, left, right, align)
  return {
    right: viewport.width - panel.left - panel.width,
    top: Math.max(64, anchor.y - size.height - 8),
    maxWidth: Math.max(1, right - left),
  }
}

/** 底栏与助手并排至少需要 380px；侧栏占用也要算进去。 */
export function canvasBottomSpace(viewportWidth: number, left: number) {
  const available = viewportWidth - left
  // 桌面视图工具栏在剩余内容区 <=680px 时分行（底栏另有 24px 内边距）。
  if (viewportWidth >= 640 && available <= 704) {
    const mascot = available < 360 ? 176 : 128
    return { mascot, generator: mascot + 64 }
  }
  return available < 380 ? { mascot: 64, generator: 128 } : { mascot: 8, generator: 64 }
}

/** 生成面板与节点之间的间距 */
const PANEL_GAP = 12
/** 面板放在节点上方时要让开节点名称标签 */
const PANEL_LABEL_GAP = 32
/** 面板压住节点下半部时，离节点中线留出输出端口的高度 */
const PANEL_PORT_CLEARANCE = 16
/** 面板至少要有的可用高度：低于它就换位置或平移相机 */
export const PANEL_MIN_USABLE_HEIGHT = 320

interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PanelPlacement {
  placement: 'below' | 'above' | 'overlap'
  left: number
  top: number
  width: number
  height: number
  /** 相机需要平移的量（屏幕像素）才能让节点与面板同时可见；放得下时为 0 */
  pan: { x: number; y: number }
}

/**
 * 节点生成面板的统一放置：下方放得下放下方，否则上方；两边都不够就让相机平移，
 * 平移也容不下整个节点时，面板上移压住节点下半部，但留出中线上的输出端口。
 * node 与 bounds 同为屏幕坐标；bounds 已扣掉侧栏、右侧浮层、顶栏和底部工具栏。
 * 返回的矩形对应「平移之后」的画面，调用方平移时让面板随节点一起移动即可。
 */
export function placeGeneratorPanel(input: {
  node: ScreenRect
  bounds: ScreenRect
  width: number
  /** 面板期望高度 */
  height: number
}): PanelPlacement {
  const { bounds } = input
  const width = Math.max(1, Math.min(input.width, bounds.right - bounds.left))
  const height = Math.max(1, input.height)
  const minHeight = Math.min(height, PANEL_MIN_USABLE_HEIGHT)

  // 水平：节点放得进可见宽度就整个移进来；比可见宽度还宽的节点不动。
  let dx = 0
  if (input.node.right - input.node.left <= bounds.right - bounds.left) {
    if (input.node.left < bounds.left) dx = bounds.left - input.node.left
    else if (input.node.right > bounds.right) dx = bounds.right - input.node.right
  }
  const node = {
    left: input.node.left + dx,
    right: input.node.right + dx,
    top: input.node.top,
    bottom: input.node.bottom,
  }
  const left = Math.max(
    bounds.left,
    Math.min((node.left + node.right - width) / 2, bounds.right - width),
  )

  const spaceBelow = bounds.bottom - (node.bottom + PANEL_GAP)
  if (spaceBelow >= minHeight) {
    const h = Math.min(height, spaceBelow)
    return {
      placement: 'below',
      left,
      top: node.bottom + PANEL_GAP,
      width,
      height: h,
      pan: { x: dx, y: 0 },
    }
  }
  const spaceAbove = node.top - PANEL_LABEL_GAP - bounds.top
  if (spaceAbove >= minHeight) {
    const h = Math.min(height, spaceAbove)
    return {
      placement: 'above',
      left,
      top: node.top - PANEL_LABEL_GAP - h,
      width,
      height: h,
      pan: { x: dx, y: 0 },
    }
  }

  // 平移：节点顶边最高停在标签之下。能放下「节点 + 间距 + 最小高度」就把面板放回下方，
  // 否则面板压住节点下半部，只要求节点中线到面板之间留出端口。
  const topLimit = bounds.top + PANEL_LABEL_GAP
  const nodeHeight = node.bottom - node.top
  const mid = (node.top + node.bottom) / 2
  if (topLimit + nodeHeight + PANEL_GAP + minHeight <= bounds.bottom) {
    const need = bounds.bottom - minHeight - PANEL_GAP - node.bottom
    const wanted = bounds.bottom - height - PANEL_GAP - node.bottom
    const dy = Math.min(need, Math.max(wanted, topLimit - node.top))
    const bottom = node.bottom + dy
    const h = Math.min(height, bounds.bottom - (bottom + PANEL_GAP))
    return {
      placement: 'below',
      left,
      top: bottom + PANEL_GAP,
      width,
      height: h,
      pan: { x: dx, y: dy },
    }
  }
  const need = bounds.bottom - minHeight - PANEL_PORT_CLEARANCE - mid
  const wanted = bounds.bottom - height - PANEL_PORT_CLEARANCE - mid
  const dy = Math.min(need, Math.max(wanted, topLimit - node.top))
  const h = Math.min(height, bounds.bottom - (mid + dy + PANEL_PORT_CLEARANCE))
  return {
    placement: 'overlap',
    left,
    top: bounds.bottom - h,
    width,
    height: h,
    pan: { x: dx, y: dy },
  }
}
