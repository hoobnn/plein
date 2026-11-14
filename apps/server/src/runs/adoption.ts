import type { CanvasElement, PleinDoc } from '@plein/doc'

/** 受理时冻结的采用身份：当时采用的结果，以及文档上的采用版本 */
export interface FrozenAdoption {
  result: string | null
  /** 文档还没有采用版本（旧画布）时为空 */
  revision?: string
}

/**
 * 文档上的采用版本：由显式采用命令写进节点，系统写入结果（addResults）不改它。
 * A→B→A 这类「结果 id 相同但人工选择确实变过」只能靠版本区分。
 *
 * 该证据必须是单调的：撤销 / 重做采用命令时不能回退到旧版本，
 * 否则「A→B→撤销回 A」和从未改过就分不出来，晚到的结果会顶掉用户的人工选择。
 */
export function adoptionRevisionOf(
  doc: PleinDoc,
  el: CanvasElement | undefined,
): string | undefined {
  if (!el) return undefined
  const typed = (el as CanvasElement & { adoptionRevision?: unknown }).adoptionRevision
  if (typeof typed === 'string') return typed
  // adoptionRevision 还没进 readElement 白名单之前，直接读元素 Y.Map；集成后走上面的类型字段
  const raw = doc.mutable(el.id)?.get('adoptionRevision')
  return typeof raw === 'string' ? raw : undefined
}

/** 受理/恢复时的采用凭据（JSON） */
export function adoptionSnapshot(
  doc: PleinDoc,
  el: CanvasElement | undefined,
  current: string | null,
) {
  if (!el) return undefined
  const revision = adoptionRevisionOf(doc, el)
  return JSON.stringify({
    result: current,
    ...(revision === undefined ? {} : { revision }),
  })
}

/** 读回受理时冻结的采用凭据；旧任务没有这一列或格式坏了返回 undefined，不做判断 */
export function parseAdoption(value: string | null | undefined): FrozenAdoption | undefined {
  if (value === null || value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null) return { result: null }
    if (typeof parsed === 'string') return { result: parsed }
    if (typeof parsed !== 'object') return undefined
    const record = parsed as { result?: unknown; revision?: unknown }
    const result =
      record.result === null || typeof record.result === 'string' ? record.result : undefined
    if (result === undefined) return undefined
    return {
      result,
      ...(typeof record.revision === 'string' ? { revision: record.revision } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * 最终写入前判断用户是否在生成期间换过采用项。
 * 有采用版本时比版本（A→B→A 也算改过）；旧画布没有版本时退回比较当前采用的结果 id。
 */
export function adoptionChanged(
  frozen: FrozenAdoption | undefined,
  current: { result: string | null; revision: string | undefined },
) {
  if (!frozen) return false
  // 受理时没有版本、现在有了：期间一定发生过显式采用
  if (frozen.revision !== undefined || current.revision !== undefined)
    return current.revision !== frozen.revision
  return current.result !== frozen.result
}
