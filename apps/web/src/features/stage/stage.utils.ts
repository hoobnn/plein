/** 人物颜色：灰模上区分人物，优先使用未占用的颜色 */
export const FIGURE_COLORS = ['#7aa2ff', '#ff8a7a', '#6fd3a8', '#f2c14e', '#b18cff', '#5cc8e0']

/** 常用焦距：广角到长焦 */
export const FOCALS = [18, 24, 35, 50, 85, 135]

/** 焦距对应的大致景别感，帮人对上分镜里的说法 */
export const focalHint = (f: number) =>
  f < 22 ? '超广角' : f < 32 ? '广角' : f < 60 ? '标准' : f < 110 ? '中长焦' : '长焦'

export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`
export const continuousGroup = (prefix: string, patch: object, fields: readonly string[]) => {
  const keys = Object.keys(patch)
  return keys.length === 1 && fields.includes(keys[0]!) ? `${prefix}:${keys[0]}` : null
}
