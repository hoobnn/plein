import { z } from 'zod'
import type { CanvasProvider, RemoteItem, SyncFields } from './provider'
import {
  call,
  checkProject,
  checkTarget,
  mutationSchema,
  readableRef,
  nodeId,
  changed,
  positionSchema,
  jimengCreateNodeId,
  projects,
  readNodes,
  listNodes,
  supportsPosition,
  resourceId,
  type DraftNode,
} from './jimeng-canvas-client'
export { jimengCreateNodeId } from './jimeng-canvas-client'
// A prompt edit replaces the full generation draft. Only reconstruct configurations
// the CLI explicitly declares writable, with a complete set of recognized fields.
const generationSchema = z
  .object({
    mode: z.string().min(1),
    prompt: z.string().optional(),
    model: z.string().optional(),
    ratio: z.string().optional(),
    resolution: z.string().optional(),
    quality: z.string().optional(),
    background: z.string().optional(),
    outputCount: z.number().int().positive(),
    durationSeconds: z.number().positive().optional(),
    scenario: z.string().optional(),
    voiceId: z.string().optional(),
    voiceName: z.string().optional(),
    references: z.array(
      z.object({
        kind: z.enum(['node', 'resource', 'res']),
        id: z.string().min(1),
        writebackSupported: z.literal(true),
      }),
    ),
    promptParts: z.array(z.unknown()),
    writebackSupported: z.literal(true),
    writebackBlockers: z.array(z.unknown()).max(0),
  })
  .strict()

function generationArgs(node: DraftNode): string[] | undefined {
  if (!['image', 'video', 'audio'].includes(node.type)) return
  const result = generationSchema.safeParse(node.generation)
  if (!result.success) return
  const g = result.data
  const args = ['--mode', g.mode]
  for (const [flag, value] of Object.entries({
    '--model': g.model,
    '--resolution': g.resolution,
    '--ratio': g.ratio,
    '--quality': g.quality,
    '--background': g.background,
    '--duration': g.durationSeconds,
    '--scenario': g.scenario,
    '--voice-id': g.voiceId,
    '--voice-name': g.voiceId ? undefined : g.voiceName,
    '--count': node.type === 'audio' ? undefined : g.outputCount,
  })) {
    if (value !== undefined && value !== '') args.push(flag, String(value))
  }
  for (const ref of g.references)
    args.push('--ref', (ref.kind === 'node' ? 'node:' : 'res:') + ref.id)
  return args
}

function referenceLabel(ref: z.infer<typeof readableRef>, index: number, usage: string) {
  const sourceId = ref.kind === 'node' && nodeId.safeParse(ref.id).success ? ref.id : undefined
  const resource =
    (ref.kind === 'res' || ref.kind === 'resource') && resourceId.safeParse(ref.id).success
      ? ref.id
      : undefined
  const name =
    ref.title && ref.title.length <= 120 && !/[\p{C}:/\\?=&]/u.test(ref.title)
      ? ref.title
      : undefined
  return {
    label: resource ? [name || '素材', resource].join(' · ') : name || '参考 ' + (index + 1),
    usage,
    ...(sourceId ? { sourceId } : {}),
  }
}

function projectedReferences(node: DraftNode) {
  if (node.type === 'element') {
    const b = node.subjectBindings
    return [
      ...(b?.main ? [referenceLabel(b.main, 0, '主素材')] : []),
      ...(b?.voice ? [referenceLabel(b.voice, 0, '音色')] : []),
      ...(b?.auxiliaries ?? []).map((ref, i) => referenceLabel(ref, i, '辅助素材')),
    ]
  }
  if (node.type === 'timeline') {
    return (node.timelineTracks?.tracks ?? []).flatMap((track, i) =>
      track.clips.map((clip, j) => referenceLabel(clip.source, j, `轨道 ${i + 1} · 片段 ${j + 1}`)),
    )
  }
  const parsed = z.array(readableRef).safeParse(node.generation?.references)
  if (!parsed.success) return []
  return parsed.data.map((ref, index) =>
    referenceLabel(
      ref,
      index,
      node.generation?.mode === 'first_last_frame' && index < 2
        ? index === 0
          ? 'firstFrame'
          : 'lastFrame'
        : 'reference',
    ),
  )
}

function projectedText(node: DraftNode, references: ReturnType<typeof projectedReferences>) {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'element' || node.type === 'timeline') {
    const label = node.type === 'timeline' ? '即梦时间轴摘要' : '即梦主体素材摘要'
    return [
      label,
      node.description,
      ...references.map((ref) => [ref.usage, ref.label, ref.sourceId].filter(Boolean).join(' · ')),
      node.timelineTracks?.clipsTruncated
        ? '即梦返回了部分片段，请在原画布查看完整轨道。'
        : undefined,
    ]
      .filter(Boolean)
      .join('\n')
  }
  return node.generation?.prompt ?? node.description ?? ''
}

function projectNode(node: DraftNode, withPosition = false): RemoteItem {
  const references = projectedReferences(node)
  return {
    ...(references.length ? { references } : {}),
    id: node.nodeId,
    kind: node.type,
    fields: {
      ...(withPosition && !node.parentNodeId && node.layout ? { position: node.layout } : {}),
      title: node.title ?? '',
      text: projectedText(node, references),
    },
    editable: node.type === 'text' || generationArgs(node) !== undefined,
  }
}

async function list(target: string): Promise<RemoteItem[]> {
  const nodes = await listNodes(target)
  const withPosition = nodes.some((n) => n.layout && !n.parentNodeId) && (await supportsPosition())
  return nodes.map((node) => projectNode(node, withPosition))
}

function sameFields(a: SyncFields, b: SyncFields) {
  return (
    a.title === b.title &&
    a.text === b.text &&
    a.position?.x === b.position?.x &&
    a.position?.y === b.position?.y
  )
}

async function verifySaved(
  raw: unknown,
  target: string,
  id: string,
  kind: string,
  expected: SyncFields,
) {
  let { node } = mutationSchema.parse(raw)
  checkProject(node.projectId, target)
  const mismatch = () => new Error('即梦保存回执与预期不符，请重新读取该节点后核对。')
  if (node.nodeId !== id || node.type !== kind) throw mismatch()
  // The public save schema makes title, text, generation and layout optional.
  // Read a sparse acknowledgement back by its exact node ID; never repeat the save.
  const missingText =
    kind === 'text' ? node.text === undefined : node.generation?.prompt === undefined
  if (
    node.title === undefined ||
    missingText ||
    (expected.position && !node.parentNodeId && !node.layout)
  ) {
    const [detail] = await readNodes(target, [id])
    if (!detail || detail.type !== kind) throw mismatch()
    node = detail
  }
  if (!sameFields(projectNode(node, !!expected.position).fields, expected)) throw mismatch()
  return node
}

async function update(target: string, item: RemoteItem, fields: SyncFields) {
  checkTarget(target)
  const [node] = await readNodes(target, [item.id])
  if (!node || node.type !== item.kind) throw changed()
  const topLevel = !!node.layout && !node.parentNodeId
  const before = projectNode(
    node,
    topLevel && (!!item.fields.position || (await supportsPosition())),
  )
  if (!!before.fields.position !== !!item.fields.position) throw changed()
  fields = {
    title: fields.title,
    text: fields.text,
    ...(before.fields.position ? { position: fields.position ?? before.fields.position } : {}),
  }
  if (!before.editable) throw new Error('此节点的配置无法由即梦 CLI 完整写回。')
  if (item.references && JSON.stringify(item.references) !== JSON.stringify(before.references))
    throw changed()
  if (sameFields(before.fields, fields)) return
  if (!sameFields(before.fields, item.fields)) throw changed()
  const args = ['node', 'edit', node.type, '--project-id', target, '--node-id', node.nodeId]
  if (
    fields.position &&
    (fields.position.x !== before.fields.position?.x ||
      fields.position.y !== before.fields.position.y)
  ) {
    const { x, y } = positionSchema.parse(fields.position)
    args.push('--x', String(x), '--y', String(y))
  }
  if (fields.title !== before.fields.title) args.push('--title', fields.title)
  const settings = generationArgs(node)
  let expectedParts: string[] | undefined
  if (fields.text !== before.fields.text) {
    if (node.type === 'text') args.push('--text', fields.text)
    else {
      // The public prompt syntax binds typed IDs. Changing the linked set requires
      // editing the actual graph, which is outside this field-level update.
      expectedParts = Array.from(
        fields.text.matchAll(/(?<!\\)\{\{((?:node|res):[^{}]+)\}\}/g),
        (m) => m[1]!,
      )
      const refs = generationSchema
        .parse(node.generation)
        .references.map((r) => (r.kind === 'node' ? 'node:' : 'res:') + r.id)
      if (expectedParts.some((token) => !refs.includes(token)))
        throw new Error('提示词含新的引用，请先在即梦节点中绑定对应素材。')
      args.push(...settings!, '--prompt', fields.text)
    }
  }
  const saved = await verifySaved(await call(args), target, node.nodeId, node.type, fields)
  if (settings && JSON.stringify(generationArgs(saved)) !== JSON.stringify(settings))
    throw new Error('保存回执中的生成参数或有序参考已变化，请在即梦核对。')
  if (expectedParts) {
    const g = generationSchema.parse(saved.generation)
    const parts = z
      .array(
        z.object({ kind: z.string(), referenceIndex: z.number().int().nonnegative().optional() }),
      )
      .parse(g.promptParts)
    const ids = parts
      .filter((p) => p.kind.toLowerCase() === 'reference' || p.kind.toLowerCase() === 'ref')
      .map((p) => {
        const ref = p.referenceIndex !== undefined ? g.references[p.referenceIndex] : undefined
        return ref ? (ref.kind === 'node' ? 'node:' : 'res:') + ref.id : undefined
      })
    if (JSON.stringify(ids) !== JSON.stringify(expectedParts))
      throw new Error('保存回执中的提示词引用位置不一致，请在即梦核对。')
  }
}

const createKinds = ['text', 'image', 'video'] as const

async function createRequest(
  target: string,
  fields: SyncFields,
  operationId: string,
  requestedKind = 'text',
) {
  const kind = z.enum(createKinds).parse(requestedKind)
  if (kind !== 'text' && !fields.title.trim())
    throw new Error('即梦图片和视频草稿需要非空标题，请先给 Plein 节点命名。')
  if (fields.title.includes('\0') || fields.text.includes('\0'))
    throw new Error('标题或正文含 CLI 无法接收的 NUL 字符。')
  checkTarget(target)
  const id = jimengCreateNodeId(operationId)
  const position =
    fields.position && (await supportsPosition())
      ? positionSchema.parse(fields.position)
      : undefined
  const args = [
    'node',
    'create',
    kind,
    '--project-id',
    target,
    '--node-id',
    id,
    '--update-id',
    operationId,
    ...(position ? ['--x', String(position.x), '--y', String(position.y)] : []),
    '--title',
    fields.title,
    ...(kind === 'text'
      ? ['--text', fields.text]
      : ['--mode', kind === 'image' ? 't2i' : 't2v', '--prompt', fields.text]),
  ]
  return { args, id, kind, position }
}

async function create(
  target: string,
  fields: SyncFields,
  operationId: string,
  requestedKind = 'text',
) {
  const { args, id, kind, position } = await createRequest(
    target,
    fields,
    operationId,
    requestedKind,
  )
  await verifySaved(await call(args), target, id, kind, { ...fields, position })
  return id
}

export const jimengCanvas: CanvasProvider = {
  list,
  update,
  create,
  projects,
  async read(target, id) {
    checkTarget(target)
    const [node] = await readNodes(target, [id])
    if (!node) throw changed()
    const writablePosition = !!node.layout && !node.parentNodeId && (await supportsPosition())
    return projectNode(node, writablePosition)
  },
  async validateCreate(fields, kind) {
    // Validate the exact argv against the installed binary before the durable intent.
    // Explicit placeholders prevent any reliance on the CLI's active project or login.
    const placeholder = '00000000-0000-4000-8000-000000000000'
    const { args } = await createRequest(placeholder, fields, placeholder, kind)
    const result = await call([...args, '--dry-run'])
    z.object({ dryRun: z.literal(true), sideEffects: z.array(z.unknown()).max(0) }).parse(result)
  },
  canCreateAtPosition: supportsPosition,
  createdId: jimengCreateNodeId,
  createKinds,
}
