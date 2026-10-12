/**
 * 提示词里的 @ 引用：`@林夏站在天台上` 引用名为“林夏”的资产卡。
 * 按名字匹配（不存 id），文本保持可读，复制粘贴到别处也看得懂；
 * 中文没有空格分词，取 @ 后能匹配上的最长名字。
 */

/** @ 后到这些字符为止 */
const STOP = /[\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]/

export interface Mention<T> {
  /** 在原文中的起止位置（含 @） */
  start: number
  end: number
  name: string
  target: T
}

/** 找出文本里引用了哪些名字；names 里没有的 @ 忽略 */
export function findMentions<T>(text: string, targets: ReadonlyMap<string, T>): Array<Mention<T>> {
  const names = [...targets.keys()].filter(Boolean).sort((a, b) => b.length - a.length)
  const out: Array<Mention<T>> = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    const rest = text.slice(i + 1)
    const name = names.find((n) => rest.startsWith(n))
    if (name) out.push({ start: i, end: i + 1 + name.length, name, target: targets.get(name)! })
  }
  return out
}

/** 光标前正在输入的 @ 查询（用于弹出候选）；不在输入 @ 时返回 null */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (STOP.test(query)) return null
  return { start: at, query }
}

/** 资产卡节点类型：可以被 @ 引用 */
export const ASSET_NODE_TYPES: ReadonlySet<string> = new Set(['plein/character', 'plein/scene'])
