import { createElements, groupElements } from './commands'
import { makeShotGroup } from './domain/shotGroup'
import type { PleinDoc } from './doc'
import { spotRightOf } from './layout'
import type { NewElement } from './types'

/** 切出来的每格在画布上的长边 */
export const GRID_TILE_SIDE = 240
export const GRID_GAP = 16
/** 切片外圈给分镜组 Frame 留的边距 */
export const GRID_PAD = 32

export interface GridTile {
  /** 从 1 开始，按行优先 */
  n: number
  row: number
  col: number
  /** 原图上的像素区域 */
  left: number
  top: number
  width: number
  height: number
  /** 在分镜组内的画布位置与大小（左上角相对切片排布的原点） */
  x: number
  y: number
  w: number
  h: number
}

export interface GridPlan {
  rows: number
  cols: number
  tiles: GridTile[]
  /** 切片排布占的画布范围，不含边距 */
  layoutW: number
  layoutH: number
  /** 含边距的分镜组大小，用来找空位 */
  frameW: number
  frameH: number
}

/**
 * 宫格切分的唯一规则：用每条分界线划分原图（余数归入后续格子，不丢右侧和底部像素），
 * 再按统一缩放排布到画布上。浏览器端和服务端都用它，切分边界不会不一致。
 */
export function gridPlan(width: number, height: number, rows: number, cols: number): GridPlan {
  if (width < cols || height < rows)
    throw new Error(
      `图片只有 ${width}×${height} 像素，无法切成 ${rows}×${cols}；请使用至少 ${cols}×${rows} 像素的图片`,
    )
  const xs = Array.from({ length: cols + 1 }, (_, c) => Math.floor((c * width) / cols))
  const ys = Array.from({ length: rows + 1 }, (_, r) => Math.floor((r * height) / rows))
  const k = GRID_TILE_SIDE / Math.max(Math.ceil(width / cols), Math.ceil(height / rows))
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, Math.round((xs[c + 1]! - xs[c]!) * k)),
  )
  const heights = Array.from({ length: rows }, (_, r) =>
    Math.max(1, Math.round((ys[r + 1]! - ys[r]!) * k)),
  )
  const tiles: GridTile[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        n: r * cols + c + 1,
        row: r,
        col: c,
        left: xs[c]!,
        top: ys[r]!,
        width: xs[c + 1]! - xs[c]!,
        height: ys[r + 1]! - ys[r]!,
        x: widths.slice(0, c).reduce((sum, w) => sum + w, 0) + c * GRID_GAP,
        y: heights.slice(0, r).reduce((sum, h) => sum + h, 0) + r * GRID_GAP,
        w: widths[c]!,
        h: heights[r]!,
      })
    }
  }
  const layoutW = widths.reduce((sum, w) => sum + w, 0) + (cols - 1) * GRID_GAP
  const layoutH = heights.reduce((sum, h) => sum + h, 0) + (rows - 1) * GRID_GAP
  return {
    rows,
    cols,
    tiles,
    layoutW,
    layoutH,
    frameW: layoutW + GRID_PAD * 2,
    frameH: layoutH + GRID_PAD * 2,
  }
}

/**
 * 把切好的图片（按 plan.tiles 的顺序给资产 id）按格子排在源元素右侧的空位，打成分镜组，
 * 并记下原图，能从组回到切之前的那张。返回分镜组 Frame 和每格的元素 id。
 */
export function placeGrid(
  doc: PleinDoc,
  sourceId: string,
  plan: GridPlan,
  assetIds: readonly string[],
): { frame: string | null; elements: string[] } {
  const spot = spotRightOf(doc, sourceId, plan.frameW, plan.frameH)
  const list: NewElement[] = plan.tiles.map((t, i) => ({
    kind: 'image',
    assetId: assetIds[i]!,
    name: `宫格 ${t.n}`,
    w: t.w,
    h: t.h,
    x: Math.round(t.x + spot.x + GRID_PAD),
    y: Math.round(t.y + spot.y + GRID_PAD),
  }))
  const elements = createElements(doc, list)
  const frame = groupElements(doc, elements, { name: `宫格切分 ${plan.rows}×${plan.cols}` })
  // 切出来的直接是分镜组：按格子顺序编号，记下原图
  if (frame)
    makeShotGroup(doc, frame, {
      cols: plan.cols,
      source: { elementId: sourceId, rows: plan.rows, cols: plan.cols },
    })
  return { frame, elements }
}
