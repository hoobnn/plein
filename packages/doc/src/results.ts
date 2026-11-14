import * as Y from 'yjs'
import { type ElementMap } from './doc'
import { sequenceSnapshot, snapshotResultEvidence } from './sequence-snapshot'
import type { NodeResult } from './types'

/**
 * 节点结果在文档里的内部存法。
 *
 * 外部快照（`CanvasElement.results`）一直是普通数组，按新到旧排列；
 * 文档内部用 `Y.Array` 存，每个候选是一条不可变的普通对象。
 *
 * ## 为什么用新的物理键
 *
 * 结果数组原本放在元素映射的 `results` 键上，值是普通 JSON 数组。
 * 同一个键上再放 `Y.Array`，滚动升级时会出事：旧客户端离线期间改了
 * `results`（仍是普通数组），重新连上后与新客户端写下的 `Y.Array`
 * 争同一个键，Yjs 按 client id 决定胜负，旧的 JSON 数组会把新的
 * `Y.Array` 整个盖掉，刚生成的候选凭空消失。
 *
 * 所以结果数组改放在新键 `resultsV2` 上，旧键 `results` 原样保留：
 * - 新客户端只写新键，旧客户端的迟到写入碰不到它；
 * - 旧客户端迟到写下的旧键内容仍在文档里，作为可核对的证据；
 * - 读取一律优先新键；旧键与新键同时存在即说明旧端改过，显式提示冲突，
 *   不静默盖掉新结果。
 *
 * ## 为什么容器随元素一起建
 *
 * 两个客户端各自给同一个节点加候选时，如果容器还不存在，两边会各造一个
 * `Y.Array` 争同一个键，输的那份候选永久丢失。容器必须随节点创建一次性
 * 建好（见 `createElements`），此后所有写入都落在同一个容器里。
 */

/** 结果数组的新物理键 */
export const RESULTS_KEY = 'resultsV2'
/** 旧物理键：v11 及更早的结果数组 */
export const LEGACY_RESULTS_KEY = 'results'
/**
 * 所有权标记：这个节点的结果已经由新端接管。
 *
 * 标记存在 = 新端拥有这个节点的结果；此时旧端迟到的写入只作冲突证据，
 * 不会让用户明确删空的候选复活。标记从未设过 = 结果还没被新端接管，
 * 旧端写来的候选可以被采纳。
 */
export const RESULTS_RECORDED_KEY = 'resultsRecorded'

/** 结果项是否是一条可用的候选记录 */
export function isResult(value: unknown): value is NodeResult {
  const v = value as NodeResult | null
  return !!v && typeof v.id === 'string' && typeof v.port === 'string' && !!v.value
}

/** 文档内部的结果容器：Y.Array */
export function resultsContainer(m: ElementMap): Y.Array<unknown> | undefined {
  const value = m.get(RESULTS_KEY)
  return value instanceof Y.Array ? value : undefined
}

/** 旧格式：`results` 是普通数组 */
export function legacyResults(m: ElementMap): NodeResult[] | undefined {
  const value = m.get(LEGACY_RESULTS_KEY)
  return Array.isArray(value) ? (value as NodeResult[]) : undefined
}

/**
 * 物理所有权标记：这个节点的结果是否已被新端接管。
 * 只看标记本身，不看旧键 —— 旧键存在只是「旧端写过」的证据。
 */
export function resultsRecorded(m: ElementMap): boolean {
  return m.get(RESULTS_RECORDED_KEY) === true
}

/** 这个节点是不是曾经有过候选（兼容旧键的推算） */
export function resultsSeen(m: ElementMap): boolean {
  if (resultsRecorded(m)) return true
  return legacyResults(m) !== undefined
}

/**
 * 读出结果条目：新键优先，旧键兜底。
 * 返回 undefined 表示这个节点根本没有结果记录。
 *
 * 新容器里有内容时一律以它为准：旧端迟到的写入留作文档里的证据，
 * 不参与读取（否则刚生成的候选会被旧数组盖掉）。
 *
 * 新容器空着时看所有权：
 * - 从未被新端接管（标记从未设过）→ 旧端的候选是目前唯一的一份，采纳；
 * - 已被新端接管（用户明确删空过）→ 保持空数组，旧端迟到的候选不复活，
 *   那份旧数组只作为显式冲突证据留在文档里。
 */
export function readRawResults(m: ElementMap): unknown[] | undefined {
  const container = resultsContainer(m)
  const legacy = legacyResults(m)
  if (container) {
    const items = container.toArray()
    if (items.length) return items
    if (legacy && !resultsRecorded(m)) return [...legacy]
    return items
  }
  return legacy ? [...legacy] : undefined
}

/**
 * 旧客户端迟到的写入：旧键还在，但没有被采纳。
 *
 * 旧键内容原样保留在文档里，作为可核对的证据；读取不采纳它，
 * 新生成的候选与用户明确删空的结果都不会被旧端盖掉。
 */
export function hasStaleLegacyWrite(m: ElementMap): boolean {
  const legacy = legacyResults(m)
  if (!legacy) return false
  const container = resultsContainer(m)
  if (!container) return false
  // 容器空着且从未被接管时，旧端的内容会被采纳，不算冲突。
  return !(!container.length && !resultsRecorded(m))
}

/**
 * 读出结果条目（新键优先，旧键兜底），并按来源深快照。
 *
 * `present` 表示这个节点确实有结果记录（哪怕是空的），
 * 调用方据此区分「没有结果」与「结果被删光了」。
 *
 * `filtered`（可用条目）与 `snapshot`（来源深快照后的条目）：
 * 两者相同说明没有需要保护的来源证据，调用方可按旧合同正常赋值；
 * 不同时快照被冻结，调用方要把它挂成不可替换的只读属性。
 */
export function readResultsSnapshot(m: ElementMap): {
  present: boolean
  filtered: NodeResult[]
  snapshot: NodeResult[]
} {
  const raw = readRawResults(m)
  if (!raw) return { present: false, filtered: [], snapshot: [] }
  // 从没产生过候选的节点：快照里不出现 results。
  // 曾经有过、后来删光的节点：快照里是空数组。
  if (!raw.length && !resultsSeen(m)) return { present: false, filtered: [], snapshot: [] }
  const filtered = raw.filter(isResult)
  const snapshot = snapshotResultEvidence(filtered)
  return { present: true, filtered, snapshot }
}

/**
 * 读出结果条目（内部数组或旧普通数组），并按来源深快照。
 * 形状与顺序对上层始终是普通数组：新到旧。
 */
export function readResults(m: ElementMap): NodeResult[] {
  return readResultsSnapshot(m).snapshot
}

/**
 * 单条候选的来源深快照：视频结果整条冻结；带原始出处的结果冻结出处部分。
 * 与 `snapshotResultEvidence` 对数组的处理逐条一致。
 *
 * 旧记录里没有出处的非视频结果原样保留：它们既不冻结也不复制，
 * 旧有的读取合同（同一份对象、调用方可继续读它的 payload）不变。
 */
export function snapshotResult(result: NodeResult): NodeResult {
  if (result.value.type === 'video') return sequenceSnapshot(result)
  if (result.generationOrigin === undefined) return result
  const snapshot = { ...result }
  Object.defineProperty(snapshot, 'generationOrigin', {
    value: sequenceSnapshot(result.generationOrigin),
    enumerable: true,
    writable: false,
    configurable: false,
  })
  return snapshot
}

/**
 * 准备写入容器的一条条结果：先全部校验并快照，再交给调用方写入。
 *
 * 旧历史里混着结构不完整的记录（缺 value、缺 id）。这里只跳过这些，
 * 其余照常迁移 —— 迁移不能因为一条坏记录丢掉整批有效结果。
 */
export function prepareResults(results: readonly unknown[]): NodeResult[] {
  const out: NodeResult[] = []
  for (const item of results) {
    if (!isResult(item)) continue
    try {
      out.push(snapshotResult(item))
    } catch {
      // 单条快照失败只影响这一条，其余结果照常迁移。
    }
  }
  return out
}

/**
 * 取到可写的 Y.Array 容器；旧键上的普通数组会按需搬进来。
 *
 * 旧格式的节点第一次被写入时必须先把旧数据搬过来：否则新容器一建好，
 * 读取就只看新键，旧候选被新键遮掉、凭空消失。
 *
 * 搬完就删掉旧键：旧键只在「旧端又写了一次」时才会重新出现，
 * 那时它就是可核对的冲突证据。内容不丢 —— 已经搬进新容器了。
 *
 * 先校验快照全部旧记录，再动容器：一条坏记录不能毁掉整批有效结果。
 */
export function ensureResultsContainer(m: ElementMap): Y.Array<unknown> {
  const existing = resultsContainer(m)
  const legacy = legacyResults(m)
  if (existing) {
    // 容器空着、旧端有候选、且结果还没被新端接管：把旧候选并进来。
    // 已经被接管（用户明确删空过）时旧端内容不复活 —— 那份旧数组只作冲突证据。
    if (!existing.length && legacy?.length && !resultsRecorded(m)) {
      const prepared = prepareResults(legacy)
      if (prepared.length) existing.insert(0, prepared)
      m.delete(LEGACY_RESULTS_KEY)
      m.set(RESULTS_RECORDED_KEY, true)
    }
    return existing
  }
  const prepared = prepareResults(legacy ?? [])
  const array = new Y.Array<unknown>()
  m.set(RESULTS_KEY, array)
  if (prepared.length) array.insert(0, prepared)
  if (legacy !== undefined) {
    m.delete(LEGACY_RESULTS_KEY)
    // 旧键存在就说明这个节点有过候选，删光之后快照仍是空数组而不是「没有结果」。
    m.set(RESULTS_RECORDED_KEY, true)
  }
  return array
}

/**
 * 整份替换容器内容（离线包重映射、检查点恢复等系统写入）。
 * 不在活文档里用：逐条插删才留得住撤销引用。
 */
export function replaceResults(m: ElementMap, results: readonly NodeResult[]): void {
  const container = ensureResultsContainer(m)
  if (container.length) container.delete(0, container.length)
  if (results.length) container.insert(0, results.map(snapshotResult))
  m.set(RESULTS_RECORDED_KEY, true)
}

/** 逐条插入到最前（新到旧）。返回实际插入的条数 */
export function insertResultsFront(
  container: Y.Array<unknown>,
  results: readonly NodeResult[],
): number {
  if (!results.length) return 0
  container.insert(0, results.map(snapshotResult))
  return results.length
}

/**
 * 按索引删除条目：从后往前删，索引才不会因删除而错位。
 * 返回实际删除的条数。
 */
export function deleteResultItems(container: Y.Array<unknown>, indexes: readonly number[]): number {
  const sorted = [...new Set(indexes)].filter((i) => i >= 0).sort((a, b) => b - a)
  let removed = 0
  for (const index of sorted) {
    if (index >= container.length) continue
    container.delete(index, 1)
    removed++
  }
  return removed
}

/** 找出这些候选在容器里的下标；容器里没有的不出现 */
export function resultIndexes(container: Y.Array<unknown>, ids: ReadonlySet<string>): number[] {
  const out: number[] = []
  const items = container.toArray()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item && typeof item === 'object' && 'id' in item && ids.has((item as NodeResult).id))
      out.push(i)
  }
  return out
}

/**
 * 一次删除留下的凭据。
 *
 * 有了它就能「只撤销这一次删除」，不必去动全局撤销栈：
 * 全局栈里那一步可能已经因为远端删除而失效，Yjs 会跳过它去撤更早的
 * 操作，把别的编辑撤掉。凭据记着删了哪几条、原本在什么位置，
 * 逐条插回原位即可。
 */
export interface ResultRemovalReceipt {
  elementId: string
  /** 被删掉的候选，连同它原本在容器里的位置 */
  entries: Array<{ result: NodeResult; index: number }>
  /** 删除前的显式采用值；撤销时按需还原 */
  adoptedBefore: string | null | undefined
}
