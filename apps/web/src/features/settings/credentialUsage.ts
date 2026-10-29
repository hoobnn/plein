/**
 * 密钥组使用情况（配置视图里的 usage：未取回结果的调用数与绑定的音色数）的文案。
 * 设置页在删除、替换前按数量把后果说清楚，卡片上显示轻量摘要；全为 0 时保持安静。
 */

export interface CredentialUsage {
  tasks: number
  voices: number
}

/** 这组 Key 名下还有没有未取回的结果或音色 */
export const credentialUsed = (usage: CredentialUsage) => usage.tasks > 0 || usage.voices > 0

/** 替换确认的提示：新 Key 可能属于另一个账号，未取回的结果和音色会失效 */
export function replaceWarning(usage: CredentialUsage): string {
  const items: string[] = []
  if (usage.tasks > 0) items.push(`${usage.tasks} 个任务的结果还没取回`)
  if (usage.voices > 0) items.push(`${usage.voices} 个音色`)
  return `这组 Key 下有 ${items.join('、')}。如果新 Key 属于另一个账号，它们会失效；换账号建议「添加一组密钥」。`
}

/** 卡片上的轻量摘要：「2 个任务待取回 · 3 个音色」；全为 0 时返回 null，不显示 */
export function usageSummary(usage: CredentialUsage): string | null {
  const items: string[] = []
  if (usage.tasks > 0) items.push(`${usage.tasks} 个任务待取回`)
  if (usage.voices > 0) items.push(`${usage.voices} 个音色`)
  return items.length > 0 ? items.join(' · ') : null
}

/** 删除确认的后果说明；全为 0 时返回 null，保持原来的简短确认 */
export function removalImpact(usage: CredentialUsage): string | null {
  const items: string[] = []
  const effects: string[] = []
  if (usage.tasks > 0) {
    items.push(`有 ${usage.tasks} 个任务的结果还没取回`)
    effects.push('这些结果无法再取回')
  }
  if (usage.voices > 0) {
    items.push(`${usage.voices} 个音色属于这组 Key`)
    effects.push('这些音色也无法再配音')
  }
  if (items.length === 0) return null
  return `${items.join('、')}。删除后${effects.join('，')}。`
}
