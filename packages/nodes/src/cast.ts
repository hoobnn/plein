/**
 * 角色与场景抽取结果 → 设定卡。
 * 短剧模板让 LLM 按固定 Markdown 输出（## 角色 / ### 名字 / - 字段：值），
 * 这里把它解析成可以直接写进角色卡、场景卡、道具卡的条目。纯函数，前后端共用。
 */

export type CastKind = 'character' | 'scene' | 'prop'

export interface CastEntry {
  kind: CastKind
  name: string
  /** 写进设定卡的设定：每个有值的字段一行，「字段：值」 */
  description: string
}

/** 二级标题里出现这些字就归到对应的卡片类型 */
const SECTIONS: Array<[RegExp, CastKind]> = [
  [/角色|人物/, 'character'],
  [/场景|地点/, 'scene'],
  [/道具/, 'prop'],
]

export const CAST_NODE_TYPES: Record<CastKind, string> = {
  character: 'plein/character',
  scene: 'plein/scene',
  prop: 'plein/prop',
}

/** 提示词模板里的占位名，LLM 原样抄回来时不算一个角色 */
const PLACEHOLDER = /^(角色|场景|道具)名?$/

const clean = (s: string) =>
  s
    .replace(/\*\*|__|`/g, '')
    .replace(/^[（(].*[)）]$/, '')
    .trim()

export function parseCast(markdown: string): CastEntry[] {
  const out: CastEntry[] = []
  let kind: CastKind | null = null
  let current: { kind: CastKind; name: string; lines: string[] } | null = null
  const flush = () => {
    const c = current as { kind: CastKind; name: string; lines: string[] } | null
    if (c?.lines.length && !PLACEHOLDER.test(c.name))
      out.push({ kind: c.kind, name: c.name, description: c.lines.join('\n') })
    current = null
  }
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    const h2 = /^##\s+(.+)$/.exec(line)
    if (h2 && !line.startsWith('###')) {
      flush()
      kind = SECTIONS.find(([re]) => re.test(h2[1]!))?.[1] ?? null
      continue
    }
    const h3 = /^###\s+(.+)$/.exec(line)
    if (h3) {
      flush()
      const name = clean(h3[1]!)
      if (kind && name) current = { kind, name, lines: [] }
      continue
    }
    if (!current || !line) continue
    const item = /^[-*+]\s*(.*)$/.exec(line)?.[1] ?? line
    const field = /^([^：:]{1,20})[：:]\s*(.*)$/.exec(item)
    if (field) {
      // 字段说明里的括号提示（如「（出图时用它保持同一个人）」）不算值
      const value = clean(field[2]!)
      if (value) current.lines.push(`${clean(field[1]!)}：${value}`)
    } else if (clean(item)) current.lines.push(clean(item))
  }
  flush()
  return out
}

export interface SpeakerTraits {
  gender?: 'female' | 'male'
  age: 'young' | 'mature'
}

const MALE = /男|先生|少爷|公子|大叔|大爷|老头|爷爷|父亲|爸|哥|弟|叔|伯|舅|他/
const FEMALE = /女|姑娘|小姐|夫人|阿姨|大妈|老太|奶奶|婆|母亲|妈|姐|妹|姨|她/
const MATURE =
  /中年|老年|年迈|花白|白发|大叔|大爷|大妈|老头|老太|爷爷|奶奶|婆婆|伯|[四五六七八九]十/

/**
 * 从角色的名字和设定里看出性别、年龄感，配音据此挑音色。
 * 先认「性别：」字段（抽取模板要求写），没有再按称谓猜；猜不出性别就留空，不乱配。
 */
export function speakerTraits(name: string, description: string): SpeakerTraits {
  const field = /(?:^|\n)\s*性别[：:]\s*(\S+)/.exec(description)?.[1] ?? ''
  const text = `${name}\n${description}`
  const fromField = /女/.test(field) ? 'female' : /男/.test(field) ? 'male' : undefined
  const male = MALE.test(text)
  const female = FEMALE.test(text)
  const gender = fromField ?? (male === female ? undefined : male ? 'male' : 'female')
  const years = yearsOf(description) ?? 0
  const mature = years >= 40 || MATURE.test(text) || /^老./.test(name)
  return { gender, age: mature ? 'mature' : 'young' }
}

const CN_TENS: Record<string, number> = {
  一: 10,
  二: 20,
  三: 30,
  四: 40,
  五: 50,
  六: 60,
  七: 70,
  八: 80,
  九: 90,
}

/** 设定里写的年龄（「二十岁」「五十多岁」「17 岁」）；没写为 undefined */
function yearsOf(description: string): number | undefined {
  const digits = /(\d{1,3})\s*多?岁/.exec(description)?.[1]
  if (digits) return Number(digits)
  const cn = /([一二三四五六七八九])十[一二三四五六七八九]?多?岁/.exec(description)?.[1]
  if (cn) return CN_TENS[cn]
  if (/十[一二三四五六七八九]?多?岁/.test(description)) return 15
  return undefined
}

/**
 * 角色存进资产库时的筛选标签（性别、年龄段，取值见 LIBRARY_KINDS），从名字和设定里看出来；
 * 看不出的不填，留给用户在资产库里选。
 */
export function characterTags(name: string, description: string): Record<string, string> {
  const tags: Record<string, string> = {}
  const { gender } = speakerTraits(name, description)
  if (gender) tags.gender = gender === 'female' ? '女' : '男'
  const text = `${name}\n${description}`
  const years = yearsOf(description)
  const age =
    years !== undefined
      ? years < 12
        ? '儿童'
        : years < 18
          ? '少年'
          : years < 40
            ? '青年'
            : years < 60
              ? '中年'
              : '老年'
      : /老年|年迈|爷爷|奶奶|老头|老太|婆婆/.test(text)
        ? '老年'
        : /中年|大叔|大妈/.test(text)
          ? '中年'
          : /少年|少女|学生/.test(text)
            ? '少年'
            : /孩子|小孩|孩童|儿童/.test(text)
              ? '儿童'
              : undefined
  if (age) tags.age = age
  return tags
}
