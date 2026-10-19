import { newShotId, Shot } from '@plein/nodes'

type Field = keyof typeof Shot.shape
const labels: Record<Field, string> = {
  id: '镜头标识',
  no: '镜号',
  duration: '时长',
  shotSize: '景别',
  description: '画面',
  characters: '出场元素',
  assetBindings: '元素绑定',
  emotion: '情绪',
  lighting: '光影',
  sfx: '音效',
  dialogue: '台词',
  imagePrompt: '分镜图提示词',
  motionPrompt: '运动提示词',
  edited: '编辑标记',
}
type Row = { index: number; fields: Field[]; labels: string[]; replace: boolean }
type Problem = { kind: 'list' } | { kind: 'rows'; count: number; rows: Row[] }
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** 不用宽松读取过滤坏行：问题与原始位置一一对应，打开时不改数据。 */
export function storyboardDataProblem(value: unknown): Problem | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return { kind: 'list' }
  const seen = new Set<string>()
  const rows: Row[] = []
  for (const [index, raw] of value.entries()) {
    if (!record(raw)) {
      rows.push({ index, fields: [], labels: ['整行格式'], replace: true })
      continue
    }
    const parsed = Shot.safeParse(raw)
    const fields = new Set<Field>(
      parsed.success
        ? []
        : parsed.error.issues
            .map((issue) => issue.path[0])
            .filter(
              (key): key is Field => typeof key === 'string' && Object.hasOwn(Shot.shape, key),
            ),
    )
    if (typeof raw.id !== 'string' || !raw.id.trim() || seen.has(raw.id)) fields.add('id')
    if (typeof raw.id === 'string' && raw.id.trim()) seen.add(raw.id)
    if (fields.size)
      rows.push({
        index,
        fields: [...fields],
        labels: [...fields].map((key) => labels[key]),
        replace: false,
      })
  }
  return rows.length ? { kind: 'rows', count: value.length, rows } : null
}

/** 用户明确恢复一行后只替换其无效字段；其他行与未知扩展字段原样保留。 */
export function restoreStoryboardRow(value: unknown, index: number): unknown[] | undefined {
  const problem = storyboardDataProblem(value)
  if (!Array.isArray(value) || problem?.kind !== 'rows') return
  const issue = problem.rows.find((row) => row.index === index)
  if (!issue) return
  const ids = new Set(value.filter(record).map((row) => row.id))
  const nos = new Set(value.filter(record).map((row) => row.no))
  const freshId = () => {
    let id = newShotId()
    while (ids.has(id)) id = newShotId()
    return id
  }
  const freshNo = () => {
    let no = index + 1
    while (nos.has(no)) no++
    return no
  }
  const row: Record<string, unknown> = issue.replace
    ? Shot.parse({ id: freshId(), no: freshNo() })
    : { ...value[index] }
  for (const key of issue.fields) {
    if (key === 'id') row.id = freshId()
    else if (key === 'no') row.no = freshNo()
    else {
      const fallback = Shot.shape[key].safeParse(undefined)
      if (!fallback.success) return
      if (fallback.data === undefined) delete row[key]
      else row[key] = fallback.data
    }
  }
  const next = [...value]
  next[index] = row
  return next
}
