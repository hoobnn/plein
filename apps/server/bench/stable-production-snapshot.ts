import assert from 'node:assert/strict'
import type { PleinDoc } from '@plein/doc'

/** 对象键规范化，数组顺序保留：剪辑、对白及字幕的顺序都是验收合同。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

export function sequenceEditState(doc: PleinDoc, sequenceId: string) {
  const sequence = doc.get(sequenceId)
  assert(sequence?.nodeType === 'plein/sequence', '剪辑快照必须指向存在的序列')
  return canonical(
    JSON.parse(
      JSON.stringify({
        params: sequence.params,
        incomingEdges: [...doc.edges()]
          .filter((edge) => edge.to[0] === sequenceId)
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    ),
  )
}
