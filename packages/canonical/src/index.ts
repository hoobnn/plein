/**
 * 稳定序列化：对象键排序，undefined 字段省略。用来给“节点 + 参数 + 输入”算缓存键，
 * 同样的内容不管键的顺序如何都得到同样的字符串。
 *
 * 独立成包是因为它不只服务于工作流：字幕、插件清单、批次快照都用它算摘要，
 * 不该让那些模块反过来依赖工作流引擎。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${Array.from(value, stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
