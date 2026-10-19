import type { ModelSpec } from '@plein/plugin-sdk'

/** 只检查所选模型声明的参数，不转换类型、不填默认值或删除扩展字段。 */
export function modelOptionsProblem(spec: ModelSpec | undefined, value: unknown) {
  const result = spec?.options?.safeParse(value)
  if (!result || result.success) return
  const fields = [
    ...new Set(
      result.error.issues.map((issue) => {
        const key = issue.path[0]
        if (typeof key !== 'string') return '参数格式'
        const title = spec?.options?.shape[key]?.meta()?.title
        return title ? `${title}（${key}）` : key
      }),
    ),
  ]
  return `${spec?.title ?? '当前模型'} 的模型专属参数无效：${fields.join('、')}。请在「参数 → 更多参数」中修正或恢复默认`
}
