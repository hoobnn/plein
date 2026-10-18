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

/** 分组工具条可换行：用实际高度避开组标题，并限制在两侧面板之间。 */
export function fitFrameToolbar(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; left: number; right: number },
) {
  const left = viewport.left + 8
  const right = viewport.width - viewport.right - 8
  const panel = fitFloatingPanel(anchor.x, size.width, left, right, 'right')
  return {
    right: viewport.width - panel.left - panel.width,
    top: Math.max(64, anchor.y - size.height - 8),
    maxWidth: Math.max(1, right - left),
  }
}
