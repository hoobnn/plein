/**
 * 提示词里的 @ 引用：`@林夏站在天台上` 引用名为“林夏”的资产卡。
 * 按名字匹配（不存 id），文本保持可读，复制粘贴到别处也看得懂；
 * 中文没有空格分词，取 @ 后能匹配上的最长名字。
 *
 * 重名必须显式消歧：画布上有两个“林夏”时，`@林夏` 不猜哪个生效，
 * 要写成 `@林夏#2`（序号按画布上元素的先后，1 起）。名字被改掉后引用会断链，
 * 这时把可能的新名字找出来提示用户改，而不是悄悄当成普通文字。
 */

/** @ 后到这些字符为止 */
const STOP = /[\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]/

/** 序号：`@林夏#2`，一到三位数字 */
const INDEX = /^#(\d{1,3})/

/** 一个可被 @ 引用的目标：名字可能重复，靠 id 区分 */
export interface MentionTarget {
  id: string
  name: string
}

/** 文本里的一处 @ 引用 */
export interface Mention {
  /** 在原文中的起止位置（含 @，含 #序号） */
  start: number
  end: number
  /** 命中的名字，不含 @ 与 #序号 */
  name: string
  /** 命中的目标 id；重名又没写序号、序号越界时为 undefined */
  id?: string
  /** 同名目标的个数：大于 1 说明光写名字指不明 */
  total: number
  /** 全部同名目标的 id，按 `sortMentionTargets` 的顺序；写 #序号 就是取这里的下标 */
  ids: string[]
  /** 用户写的序号（`@林夏#2` 里的 2），没写为 undefined */
  index?: number
}

/** 一处 @ 引用没有对上画布上的任何名字（多半是被改名了） */
export interface BrokenMention {
  start: number
  end: number
  /** 没对上名字的原文，不含 @ */
  name: string
  /** 像是改名前的名字的候选，按像的程度排序 */
  candidates: string[]
}

/**
 * 同名目标的 `#序号` 顺序：按元素 id 排。
 * 不能用 doc.elements() 的遍历顺序——那是 Y.Map 的插入 / 解码顺序，增量同步的副本与
 * 从快照加载的副本（服务端重启、新开浏览器）会不一样，`@林夏#2` 就会在两端指向不同的卡。
 */
export function sortMentionTargets<T extends MentionTarget>(targets: readonly T[]): T[] {
  return [...targets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 按名字归拢目标，同名的按 `sortMentionTargets` 排 */
function groupByName(targets: readonly MentionTarget[]) {
  const byName = new Map<string, MentionTarget[]>()
  for (const t of sortMentionTargets(targets)) {
    const name = t.name.trim()
    if (!name) continue
    const list = byName.get(name)
    if (list) list.push(t)
    else byName.set(name, [t])
  }
  return byName
}

/** 找出文本里引用了哪些目标；完全对不上名字的交给 findBrokenMentions */
export function findMentions(text: string, targets: readonly MentionTarget[]): Array<Mention> {
  const byName = groupByName(targets)
  // 长的名字优先：`@林夏夏` 是人名，不是 `@林夏` 后面多一个字
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  const out: Array<Mention> = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    const rest = text.slice(i + 1)
    const name = names.find((n) => rest.startsWith(n))
    if (!name) continue
    const list = byName.get(name)!
    const asked = rest.slice(name.length).match(INDEX)
    const index = asked ? Number(asked[1]) : undefined
    const picked = index && index >= 1 && index <= list.length ? list[index - 1] : undefined
    out.push({
      start: i,
      end: i + 1 + name.length + (asked ? asked[0].length : 0),
      name,
      // 重名又没写序号时不猜：id 留空，交给调用方提示用户消歧
      id: picked?.id ?? (index === undefined && list.length === 1 ? list[0]!.id : undefined),
      total: list.length,
      ids: list.map((t) => t.id),
      index,
    })
  }
  return out
}

/** 这个名字可以照抄的消歧写法（带 @，用户直接粘进提示词）：`@林夏`、`@林夏#2` */
export function mentionChoices(m: Mention): string[] {
  return m.total > 1 ? m.ids.map((_, i) => `@${m.name}#${i + 1}`) : [`@${m.name}`]
}

/**
 * 这处引用没法用时给用户的话：重名没写序号、或者序号越界。
 * 不给 undefined 就说明引用是清楚的，直接用即可。
 */
export function mentionProblem(m: Mention): string | undefined {
  if (m.id) return undefined
  const at = `@${m.name}${m.index === undefined ? '' : `#${m.index}`}`
  if (m.index !== undefined)
    return `「${at}」不存在，画布上「${m.name}」只有 ${mentionChoices(m).join('、')}`
  return `画布上有 ${m.total} 个「${m.name}」，请写成 ${mentionChoices(m).join(' 或 ')}`
}

/**
 * 找出对不上名字的 @ 引用：多半是资产卡被改名了。
 * 中文没有词边界，`@林夏站在天台` 会整串当成名字，所以只有首字相同的候选才提示，
 * 否则 `@所有人`、`@someone` 这类普通写法会天天误报。
 */
export function findBrokenMentions(
  text: string,
  targets: readonly MentionTarget[],
): Array<BrokenMention> {
  const hit = new Set(findMentions(text, targets).map((m) => m.start))
  const names = [...groupByName(targets).keys()]
  const out: Array<BrokenMention> = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (hit.has(i)) continue
    const word = text
      .slice(i + 1)
      .match(/^[^\s@#，。,.!！?？:：;；、（）()【】[\]「」"'“”]{1,12}/)?.[0]
    if (!word) continue
    const candidates = similarNames(word, names)
    if (candidates.length === 0) continue
    out.push({ start: i, end: i + 1 + word.length, name: word, candidates })
  }
  return out
}

/**
 * 和这个名字像的候选：改名通常留着姓或首字，按公共前缀的长度排序。
 * 首字不同的一律不算像——中文单字重合太常见（「天台」和「林夏站在天台」），
 * 报出来只会变成噪音，用户也就不会看这类提示了。
 */
export function similarNames(query: string, names: readonly string[], limit = 4): string[] {
  if (!query) return []
  const scored: Array<{ name: string; score: number }> = []
  for (const name of names) {
    let prefix = 0
    while (prefix < name.length && name[prefix] === query[prefix]) prefix++
    if (prefix === 0) continue
    scored.push({ name, score: prefix })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name)
}

/** 一个可被 @ 引用的目标的名字与候选（输入框弹出提示用） */
export interface MentionCandidate {
  name: string
  /** 插进提示词的写法：重名时自带 #序号 */
  insert: string
  /** 同名的目标个数 */
  total: number
}

/** 光标前正在输入的 @ 查询（用于弹出候选）；不在输入 @ 时返回 null */
export function mentionQuery(
  text: string,
  caret: number,
  targets: readonly MentionTarget[] = [],
): { start: number; query: string; candidates: MentionCandidate[] } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (STOP.test(query)) return null
  const byName = groupByName(targets)
  const candidates: MentionCandidate[] = []
  // 重名时一个目标给一条候选：用户要指明是哪一个，光给名字没用
  for (const [name, list] of byName) {
    if (query && !name.includes(query)) continue
    for (const [i] of list.entries())
      candidates.push({
        name,
        insert: list.length > 1 ? `${name}#${i + 1}` : name,
        total: list.length,
      })
  }
  return { start: at, query, candidates }
}

/** 资产卡节点类型：可以被 @ 引用 */
export const ASSET_NODE_TYPES: ReadonlySet<string> = new Set([
  'plein/character',
  'plein/scene',
  'plein/prop',
  'plein/style',
])
