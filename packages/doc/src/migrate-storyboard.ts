import * as Y from 'yjs'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined

/** 旧分镜一次性补身份；不改提示词、历史、采用结果或音色。 */
export function migrateStoryboardIdentity(ydoc: Y.Doc) {
  const elements = ydoc.getMap<Y.Map<unknown>>('elements')
  // video@2 增加兼容的可选端口；旧画布保存的端口快照也必须补上，才能实际连线。
  for (const [, el] of elements) {
    if (
      !(el instanceof Y.Map) ||
      el.get('nodeType') !== 'plein/video' ||
      el.get('nodeVersion') !== 2
    )
      continue
    const ports = record(el.get('ports'))
    if (!ports || !Array.isArray(ports.inputs)) continue
    const inputs = [...ports.inputs]
    for (const [id, label, type] of [
      ['videos', '参考视频', 'video'],
      ['audios', '参考音频', 'audio'],
    ]) {
      if (!inputs.some((port) => record(port)?.id === id))
        inputs.push({ id, label, type, multiple: true })
    }
    if (inputs.length !== ports.inputs.length) el.set('ports', { ...ports, inputs })
  }
  const cards = [...elements].filter(
    ([, el]) =>
      el instanceof Y.Map &&
      (['plein/character', 'plein/scene', 'plein/prop', 'plein/style', 'plein/effect'].includes(
        String(el.get('nodeType')),
      ) ||
        el.get('kind') === 'image') &&
      typeof el.get('name') === 'string',
  )
  const bind = (name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return undefined
    const same = cards.filter(([, el]) => String(el.get('name')).trim() === name)
    if (same.length !== 1) return undefined
    const [elementId, el] = same[0]!
    const libraryId =
      el.get('params') instanceof Y.Map
        ? (el.get('params') as Y.Map<unknown>).get('libraryId')
        : undefined
    return { elementId, ...(typeof libraryId === 'string' ? { libraryId } : {}) }
  }
  const boards = new Map<string, RecordValue[]>()
  for (const [boardId, el] of elements) {
    if (!(el instanceof Y.Map) || el.get('nodeType') !== 'plein/storyboard') continue
    const params = el.get('params')
    if (!(params instanceof Y.Map) || !Array.isArray(params.get('shots'))) continue
    const shots = (params.get('shots') as unknown[]).map((value) => {
      const shot = record(value)
      if (!shot || typeof shot.id !== 'string') return value
      const assetBindings = { ...record(shot.assetBindings) }
      for (const name of Array.isArray(shot.characters) ? shot.characters : []) {
        if (typeof name !== 'string' || assetBindings[name]) continue
        const binding = bind(name)
        if (binding) assetBindings[name] = binding
      }
      const used = new Set<string>()
      const dialogue = (Array.isArray(shot.dialogue) ? shot.dialogue : []).map((value, i) => {
        const line = record(value)
        if (!line) return value
        const proposed =
          typeof line.id === 'string' && line.id ? line.id : `dialogue_${shot.id}_${i}`
        const id = used.has(proposed) ? `${proposed}_${i}` : proposed
        used.add(id)
        const speaker = record(line.speaker) ?? bind(line.character)
        return { ...line, id, ...(speaker ? { speaker } : {}) }
      })
      return { ...shot, assetBindings, dialogue }
    })
    params.set('shots', shots)
    boards.set(
      boardId,
      shots.filter((s): s is RecordValue => !!record(s)),
    )
  }
  const claimed = new Map<string, Set<string>>()
  for (const [, el] of elements) {
    if (!(el instanceof Y.Map)) continue
    const params = el.get('params')
    if (!(params instanceof Y.Map)) continue
    const source = record(params.get('source'))
    if (!source || source.role !== 'speech' || typeof source.dialogueId === 'string') continue
    const shot = boards.get(String(source.storyboard))?.find((s) => s.id === source.shot)
    if (!shot || !Array.isArray(shot.dialogue)) continue
    const lines = shot.dialogue.map(record)
    const key = `${source.storyboard}:${source.shot}`
    const used = claimed.get(key) ?? new Set<string>()
    claimed.set(key, used)
    const text = record(record(source.plan)?.params)?.text ?? params.get('text')
    const original = typeof source.line === 'number' ? source.line : 0
    const available = lines.filter(
      (line): line is RecordValue => !!line && typeof line.id === 'string' && !used.has(line.id),
    )
    const exact = available.filter((line) => line.line === text)
    const chosen =
      exact.find((line) => line === lines[original]) ??
      exact[0] ??
      available.find((line) => line === lines[original])
    if (!chosen) continue
    used.add(String(chosen.id))
    params.set('source', { ...source, line: lines.indexOf(chosen), dialogueId: chosen.id })
  }
}
