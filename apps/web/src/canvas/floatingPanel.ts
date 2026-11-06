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
/**
 * 面板至少要有的可用高度：低于它就换位置或平移相机。
 * 标题、参考区、至少 120px 的提示词、辅助区一行和底部工具栏合起来约 390px，
 * 再矮「实际输入」等区域就要靠滚动才看得到。
 */
export const PANEL_MIN_USABLE_HEIGHT = 400

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
  /** 相机平移（屏幕像素）后，节点与面板能按更舒服的布局同屏；已经放得下时为 0 */
  pan: { x: number; y: number }
}

/** 压住节点下半部又没有平移余地时，面板至少保留的高度 */
const PANEL_FLOOR_HEIGHT = 160

/**
 * 节点生成面板的统一放置：下方放得下放下方，否则上方；两边都不够就压住节点下半部，
 * 只留出中线上的输出端口。node 与 bounds 同为屏幕坐标；bounds 已扣掉侧栏、
 * 右侧浮层、顶栏和底部工具栏，面板宽度按它收。
 *
 * 返回的矩形是相机不动时的布局，任何时候都成立；`pan` 是建议的相机平移量：
 * 平移后下方（或上方）能放下最小可用高度，调用方愿意平移时再用。
 */
export function placeGeneratorPanel(input: {
  node: ScreenRect
  bounds: ScreenRect
  width: number
  /** 面板期望高度 */
  height: number
}): PanelPlacement {
  const { node, bounds } = input
  const width = Math.max(1, Math.min(input.width, bounds.right - bounds.left))
  const height = Math.max(1, input.height)
  const minHeight = Math.min(height, PANEL_MIN_USABLE_HEIGHT)
  const centerLeft = (centre: number) =>
    Math.max(bounds.left, Math.min(centre - width / 2, bounds.right - width))
  const left = centerLeft((node.left + node.right) / 2)

  // 相机建议：水平把节点整个移进可见宽度（比可见宽度还宽的节点不动）
  let dx = 0
  if (node.right - node.left <= bounds.right - bounds.left) {
    if (node.left < bounds.left) dx = bounds.left - node.left
    else if (node.right > bounds.right) dx = bounds.right - node.right
  }
  // 垂直：节点顶边最高停在标签之下。能放下「节点 + 间距 + 最小高度」就让面板回到下方，
  // 否则只要求节点中线到面板之间留出端口。
  const spaceBelow = bounds.bottom - (node.bottom + PANEL_GAP)
  const spaceAbove = node.top - PANEL_LABEL_GAP - bounds.top
  const topLimit = bounds.top + PANEL_LABEL_GAP
  const mid = (node.top + node.bottom) / 2
  let dy = 0
  if (spaceBelow < minHeight && spaceAbove < minHeight) {
    if (topLimit + (node.bottom - node.top) + PANEL_GAP + minHeight <= bounds.bottom) {
      const need = bounds.bottom - minHeight - PANEL_GAP - node.bottom
      const wanted = bounds.bottom - height - PANEL_GAP - node.bottom
      dy = Math.min(need, Math.max(wanted, topLimit - node.top))
    } else {
      const need = bounds.bottom - minHeight - PANEL_PORT_CLEARANCE - mid
      const wanted = bounds.bottom - height - PANEL_PORT_CLEARANCE - mid
      dy = Math.min(need, Math.max(wanted, topLimit - node.top))
    }
  }
  const pan = { x: dx, y: dy }

  if (spaceBelow >= minHeight) {
    const h = Math.min(height, spaceBelow)
    return { placement: 'below', left, top: node.bottom + PANEL_GAP, width, height: h, pan }
  }
  if (spaceAbove >= minHeight) {
    const h = Math.min(height, spaceAbove)
    return {
      placement: 'above',
      left,
      top: node.top - PANEL_LABEL_GAP - h,
      width,
      height: h,
      pan,
    }
  }
  // 相机不动：贴着可用区域底边，上沿停在输出端口之下
  const h = Math.min(
    height,
    Math.max(bounds.bottom - (mid + PANEL_PORT_CLEARANCE), Math.min(height, PANEL_FLOOR_HEIGHT)),
  )
  return { placement: 'overlap', left, top: bounds.bottom - h, width, height: h, pan }
}
