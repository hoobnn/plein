import { type PleinDoc } from '@plein/doc'
import {
  dropShot,
  newDialogueId,
  newShotId,
  SHOT_SIZES,
  Shot,
  ShotDialogue,
  STORYBOARD_TYPE,
} from '@plein/nodes'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'
import { detachShot, expandedNodes, shotsOf, writeStoryboardShots } from './story/storyboard'

/**
 * 分镜逐镜编辑：与分镜编辑器同一条写入路径（writeStoryboardShots：先补记旧计划基线，
 * 再写分镜表，同一次撤销），所以 sync_storyboard 对「计划变了」与「节点被手改」的判定不受影响。
 */

const id = z.string().min(1).max(200)

/** 分镜版本：整张分镜表的指纹，写入时用来拒绝基于过期内容的修改 */
export function shotsVersion(shots: unknown): string {
  const text = JSON.stringify(shots ?? [])
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return `${(h >>> 0).toString(36)}.${text.length}`
}

/** 逐镜可改的字段；id、镜号、edited 和资产绑定由宿主维护 */
const fields = z.object({
  duration: z.number().min(1).max(30).describe('时长（秒），1–30'),
  shotSize: z.enum(SHOT_SIZES).describe('景别'),
  description: z.string().describe('画面描述'),
  characters: z.array(z.string()).describe('出场的角色、场景、道具的名字（对应画布上的资产卡）'),
  emotion: z.string(),
  lighting: z.string(),
  sfx: z.string().describe('音效'),
  dialogue: z
    .array(ShotDialogue.pick({ id: true, character: true, line: true }))
    .describe(
      '整段台词替换。带 id 的沿用原台词身份（已展开的配音节点按它对应），没带 id 的：与原台词说话人和文字完全相同则沿用，否则视为新台词',
    ),
  imagePrompt: z.string().describe('分镜图提示词'),
  motionPrompt: z.string().describe('视频运动提示词'),
  cameraMotion: z.string().describe('运镜意图'),
})
const patchFields = fields.partial().strict()

const op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    shot: patchFields.optional().describe('新镜头的内容；缺省字段用默认值'),
  }),
  z.object({ op: z.literal('patch'), shot_id: id, fields: patchFields }),
  z.object({
    op: z.literal('move'),
    shot_id: id,
    to: z.number().int().min(0).describe('移到第几位（从 0 起）'),
  }),
  z.object({ op: z.literal('remove'), shot_id: id }),
])
type Op = z.infer<typeof op>

const boardOf = (doc: PleinDoc, boardId: string) => {
  const el = need(doc, boardId)
  if (el.nodeType !== STORYBOARD_TYPE) throw new CapabilityError(`${boardId} 不是分镜节点`)
  // 与编辑器一致：表里有格式不对的行就不动它，免得整表写回丢掉那些行
  const raw = el.params?.shots
  if (raw !== undefined && !Array.isArray(raw))
    throw new CapabilityError('分镜表格式不对，先在分镜编辑器里修复')
  const seen = new Set<string>()
  for (const row of raw ?? []) {
    const parsed = Shot.safeParse(row)
    if (!parsed.success || seen.has(parsed.data.id))
      throw new CapabilityError('分镜表里有格式不对或重复的行，先在分镜编辑器里修复')
    seen.add(parsed.data.id)
  }
  return { el, shots: shotsOf(el) }
}

export const getShots = defineCapability({
  name: 'get_shots',
  title: '读取分镜表',
  group: 'story',
  where: 'doc',
  effect: 'read',
  description:
    '分页读取分镜节点的镜头表：每个镜头的 id、镜号 no、时长、景别、画面、出场角色、台词（带 id）、提示词、是否手改过 edited，以及已展开的节点数 expanded_nodes。返回 version，供 edit_shots 的 expected_version 使用。',
  input: z.object({
    id: id.describe('分镜节点'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const { el, shots } = boardOf(doc, a.id)
      const expanded = expandedNodes(doc, el.id)
      const page = shots.slice(a.offset, a.offset + a.limit)
      return {
        id: el.id,
        version: shotsVersion(el.params?.shots),
        total: shots.length,
        shots: page.map((s) => ({ ...s, expanded_nodes: expanded.get(s.id)?.length ?? 0 })),
        ...(a.offset + page.length < shots.length ? { next_offset: a.offset + page.length } : {}),
      }
    }),
})

function dialogueOf(previous: Shot['dialogue'], next: z.infer<typeof fields>['dialogue']) {
  const used = new Set<number>()
  return next.map((line) => {
    const byId = line.id ? previous.findIndex((p, i) => !used.has(i) && p.id === line.id) : -1
    const at =
      byId >= 0
        ? byId
        : line.id
          ? -1
          : previous.findIndex(
              (p, i) => !used.has(i) && p.character === line.character && p.line === line.line,
            )
    if (at >= 0) used.add(at)
    const old = at >= 0 ? previous[at] : undefined
    return {
      ...(old?.speaker ? { speaker: old.speaker } : {}),
      character: line.character,
      line: line.line,
      id: old?.id ?? line.id ?? newDialogueId(),
    }
  })
}

function apply(shots: Shot[], ops: Op[]) {
  let list = [...shots]
  const done: Array<Record<string, unknown>> = []
  const find = (shotId: string) => {
    const at = list.findIndex((s) => s.id === shotId)
    if (at < 0) throw new CapabilityError(`没有镜头 ${shotId}，先用 get_shots 查看镜头 id`)
    return at
  }
  const patched = (s: Shot, f: z.infer<typeof patchFields>): Shot => {
    const { dialogue, ...rest } = f
    return {
      ...s,
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(dialogue ? { dialogue: dialogueOf(s.dialogue, dialogue) } : {}),
      edited: true,
    }
  }
  const removed: string[] = []
  for (const o of ops) {
    if (o.op === 'add') {
      // 与编辑器的「加镜头」一致：接在最后，镜号是最后一行的下一个
      const base: Shot = {
        id: newShotId(),
        no: (list.at(-1)?.no ?? 0) + 1,
        duration: 5,
        shotSize: '中景',
        description: '',
        characters: [],
        emotion: '',
        lighting: '',
        sfx: '',
        dialogue: [],
        imagePrompt: '',
        motionPrompt: '',
        edited: true,
      }
      const shot = patched({ ...base, dialogue: [] }, o.shot ?? {})
      list.push(shot)
      done.push({ op: 'add', shot_id: shot.id, no: shot.no })
    } else if (o.op === 'patch') {
      const at = find(o.shot_id)
      if (!Object.keys(o.fields).length) throw new CapabilityError('patch 没有要改的字段')
      list[at] = patched(list[at]!, o.fields)
      done.push({ op: 'patch', shot_id: o.shot_id, fields: Object.keys(o.fields) })
    } else if (o.op === 'move') {
      const at = find(o.shot_id)
      const numbers = list.map((s) => s.no).sort((a, b) => a - b)
      const [moved] = list.splice(at, 1)
      list.splice(Math.min(o.to, list.length), 0, moved!)
      // 镜号集合不变，按新顺序重新分配；镜号变了的行记为手改，重新生成时不被覆盖
      list = list.map((s, i) => (s.no === numbers[i] ? s : { ...s, no: numbers[i]!, edited: true }))
      done.push({ op: 'move', shot_id: o.shot_id, to: list.findIndex((s) => s.id === o.shot_id) })
    } else {
      find(o.shot_id)
      list = dropShot(list, o.shot_id).shots
      removed.push(o.shot_id)
      done.push({ op: 'remove', shot_id: o.shot_id })
    }
  }
  return { list, done, removed }
}

export const editShots = defineCapability({
  name: 'edit_shots',
  title: '逐镜修改分镜表',
  group: 'story',
  where: 'doc',
  effect: (a) => (a.ops.some((o) => o.op === 'remove') ? 'destructive' : 'edit'),
  approval: (a) =>
    a.ops.some((o) => o.op === 'remove')
      ? { reason: '删除分镜镜头（已展开的节点和产物保留，标记为脱离计划）', ids: [a.id] }
      : null,
  description:
    '与分镜编辑器共用写入路径，逐镜修改分镜表而不用整表替换：add 在最后加一个镜头（镜号接最后一行）；patch 只改指定镜头的指定字段（改过的镜头记为手改 edited，重新生成时不覆盖）；move 把镜头移到第 to 位并按新顺序重排镜号；remove 删除镜头，已展开的节点和产物保留并标为脱离计划。ops 按顺序执行，全部成功才写入，一次撤销。先 get_shots，携带 version 作为 expected_version，分镜表已变化会拒绝。改完用 sync_storyboard 查看已展开节点的差异；不要用 update_element 整表替换 shots。不运行、不生成。',
  input: z.object({
    id: id.describe('分镜节点'),
    expected_version: z.string().max(64),
    ops: z.array(op).min(1).max(100),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const { el, shots } = boardOf(doc, a.id)
      if (el.locked || doc.readOnly) throw new CapabilityError('分镜节点已锁定或画布只读')
      if (a.expected_version !== shotsVersion(el.params?.shots))
        throw new CapabilityError('分镜表已变化，请重新 get_shots')
      const { list, done, removed } = apply(shots, a.ops)
      let detached = 0
      doc.undo.stopCapturing()
      doc.ydoc.transact(() => {
        writeStoryboardShots(doc, a.id, list)
        for (const shotId of removed) detached += detachShot(doc, a.id, shotId)
      }, doc.origin)
      doc.flush()
      doc.undo.stopCapturing()
      return {
        id: a.id,
        version: shotsVersion(doc.get(a.id)?.params?.shots),
        total: list.length,
        applied: done,
        ...(removed.length ? { detached_nodes: detached } : {}),
      }
    }),
})

export const shotCapabilities = [getShots, editShots]
