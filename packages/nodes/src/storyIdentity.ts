import { z } from 'zod'

/** 分镜内的对象身份；名称留在原字段里作显示，绑定后不再按同名对象猜测。 */
export const ShotAssetBinding = z.object({
  elementId: z.string().min(1).optional(),
  libraryId: z.string().min(1).optional(),
})
export type ShotAssetBinding = z.infer<typeof ShotAssetBinding>

export const ShotDialogue = z.object({
  /** 旧文档允许缺省，读取 / 编辑 / 展开时由宿主补齐。 */
  id: z.string().min(1).optional(),
  character: z.string(),
  line: z.string(),
  speaker: ShotAssetBinding.optional(),
})
export type ShotDialogue = z.infer<typeof ShotDialogue>

let serial = 0
export const newDialogueId = () =>
  `dialogue_${Date.now().toString(36)}_${(serial++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`

/** 旧台词用镜头 id + 原序号迁移；多次读取得到同一 id，不制造文档写入。 */
export function normalizeDialogue(shotId: string, lines: ShotDialogue[]): ShotDialogue[] {
  const seen = new Set<string>()
  return lines.map((line, i) => {
    const proposed = line.id || `dialogue_${shotId}_${i}`
    const id = seen.has(proposed) ? `${proposed}_${i}` : proposed
    seen.add(id)
    return line.id === id ? line : { ...line, id }
  })
}

/** 模型重生成是新计划：仅精确相同的说话人与台词沿用身份，其余分配新 id。 */
export function reconcileDialogue(previous: ShotDialogue[], next: ShotDialogue[]): ShotDialogue[] {
  const used = new Set<number>()
  return next.map((line) => {
    const at = previous.findIndex(
      (old, i) => !used.has(i) && old.character === line.character && old.line === line.line,
    )
    const old = at < 0 ? undefined : previous[at]
    if (at >= 0) used.add(at)
    return {
      ...line,
      id: old?.id ?? newDialogueId(),
      ...(old?.speaker ? { speaker: old.speaker } : {}),
    }
  })
}
