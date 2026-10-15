import type { ContinuesFrom } from './core'

/** 续镜沿用父镜头的这些设置；提示词不沿用，下一个镜头要写新的 */
export const CONTINUE_CARRY = [
  'model',
  'duration',
  'aspectRatio',
  'resolution',
  'audio',
  'options',
] as const

/**
 * 续镜节点的参数（界面和智能体共用）：图生视频，记下来路；
 * 父镜头是同类视频节点时沿用模型、时长、画幅等，否则用给的画幅（按画面比例挑的）。
 */
export function continueShotParams(opts: {
  defaults: Record<string, unknown>
  /** 节点声明里有的参数名 */
  keys: Iterable<string>
  /** 父镜头是同类视频节点时它的参数 */
  parent?: Record<string, unknown>
  aspect?: { key: string; value: unknown }
  from: ContinuesFrom
  prompt?: string
}): Record<string, unknown> {
  const keys = new Set(opts.keys)
  const params: Record<string, unknown> = { ...opts.defaults }
  if (opts.parent) {
    for (const k of CONTINUE_CARRY)
      if (keys.has(k) && opts.parent[k] !== undefined) params[k] = opts.parent[k]
  } else if (opts.aspect && keys.has(opts.aspect.key)) {
    params[opts.aspect.key] = opts.aspect.value
  }
  if (keys.has('mode')) params.mode = 'image'
  if (keys.has('continuesFrom')) params.continuesFrom = opts.from
  if (opts.prompt && keys.has('prompt')) params.prompt = opts.prompt
  return params
}

/** 画幅选项里最接近 w×h 的那个（不选「智能」等读不出比例的）；没有尺寸时返回 undefined */
export function nearestAspect(options: readonly unknown[], w?: number, h?: number) {
  if (!w || !h) return undefined
  const want = Math.log(w / h)
  let best: { v: unknown; d: number } | undefined
  for (const v of options) {
    const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v) : null
    if (!m) continue
    const d = Math.abs(Math.log(Number(m[1]) / Number(m[2])) - want)
    if (!best || d < best.d) best = { v, d }
  }
  return best?.v
}
