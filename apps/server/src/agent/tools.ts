import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  adoptResult,
  type CanvasElement,
  connect,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  elementPorts,
  type NewElement,
  type NodeResult,
  type PleinDoc,
  type Port,
  portsCompatible,
  type Rect,
  removeEdges,
  setParams,
  setParent,
  setText,
  updateElement,
} from '@plein/doc'
import { describeNode, executionOf } from '@plein/plugin-sdk'
import sharp, { type Sharp } from 'sharp'
import { z } from 'zod'
import { ffmpegBin, hasFfmpeg } from '../assets/media'
import type { AssetStore } from '../assets/store'
import { NodeRunError, type PluginHost } from '../plugins/host'
import type { NodeRuns } from '../runs/runs'
import type { Rooms } from '../sync/rooms'
import { defineTool, type McpTool, type ToolContent, ToolError } from './mcp'

const exec = promisify(execFile)

/** 工具运行时绑定的画布与身份 */
export interface ToolEnv {
  canvasId: string
  ownerId: string
  rooms: Rooms
  runs: NodeRuns
  host: PluginHost
  assets: AssetStore
}

/** 单次等待运行结果的上限：Codex 默认 60 秒工具超时，留出余量 */
const MAX_WAIT_S = 50
/** 新元素与参照元素之间的间距 */
const GAP = 80
const LONG_TEXT = 400

const id = z.string().min(1).max(200)
const position = {
  near: id.optional().describe('放在这个元素右侧的空位；不填且没给 x/y 时放在画布内容右侧'),
  x: z.number().optional().describe('世界坐标 x（左上角），与 near 二选一'),
  y: z.number().optional(),
  parent_id: id.optional().describe('放进这个 Frame（分组）里'),
}

export function canvasTools(env: ToolEnv): McpTool[] {
  const { host } = env

  const withDoc = <T>(fn: (doc: PleinDoc) => T): T => {
    const doc = createDoc(env.rooms.get(env.canvasId).doc)
    try {
      return fn(doc)
    } finally {
      doc.destroy()
    }
  }

  const need = (doc: PleinDoc, elementId: string) => {
    const el = doc.get(elementId)
    if (!el) throw new ToolError(`元素 ${elementId} 不存在，先用 get_canvas 查看当前画布`)
    return el
  }

  const asset = (assetId: string) => {
    const a = env.assets.get(env.ownerId, assetId)
    if (!a) throw new ToolError(`资产 ${assetId} 不存在`)
    return a
  }

  return [
    defineTool({
      name: 'get_canvas',
      description:
        '读取当前画布：所有元素（id、类型、名称、位置、节点参数、运行状态、当前结果）和连线。开始工作前先调用它。',
      input: z.object({
        frame_id: id.optional().describe('只看这个 Frame 里的内容'),
      }),
      run: ({ frame_id }) =>
        withDoc((doc) => {
          const els = frame_id
            ? [need(doc, frame_id), ...doc.descendants(frame_id)]
            : [...doc.elements()]
          const ids = new Set(els.map((e) => e.id))
          const edges = [...doc.edges()]
            .filter((e) => ids.has(e.from[0]) || ids.has(e.to[0]))
            .map((e) => `${e.id}: ${e.from[0]}.${e.from[1]} → ${e.to[0]}.${e.to[1]}`)
          return json({
            elements: els.map((el) => summarize(doc, el, false)),
            edges,
          })
        }),
    }),

    defineTool({
      name: 'get_element',
      description: '读取一个元素的完整信息：全部参数、Markdown 正文、所有历史结果（含结果 id）。',
      input: z.object({ id }),
      run: ({ id }) => withDoc((doc) => json(summarize(doc, need(doc, id), true))),
    }),

    defineTool({
      name: 'list_node_types',
      description:
        '列出可以创建的节点类型：用途、输入输出端口、参数 JSON Schema 与默认值，以及当前已启用、可选的模型（model 参数填 ref；留空则自动选择）。',
      input: z.object({}),
      run: () => {
        const out = []
        for (const [key, n] of host.registry.nodes) {
          const latest = host.registry.latestNode(n.def.type)
          if (latest?.def.version !== n.def.version) continue
          const d = describeNode(n.def, n.plugin)
          out.push({
            type: d.type,
            title: d.title,
            description: d.description,
            runnable: executionOf(n.def) === 'inline' || host.registry.executors.has(key),
            inputs: d.inputs,
            outputs: d.outputs,
            params: (d.paramsSchema as { properties?: unknown }).properties,
            defaults: d.defaults,
            models: d.capability
              ? host.models(d.capability).map((m) => ({ ref: m.ref, title: m.title }))
              : undefined,
          })
        }
        return json(out)
      },
    }),

    defineTool({
      name: 'create_node',
      description:
        '新建一个工作流节点（如 plein/image、plein/video、plein/speech、plein/sequence）。可同时把上游元素连到它的输入端口。只建不跑，运行用 run_node。',
      input: z.object({
        type: z.string().describe('节点类型，见 list_node_types'),
        params: z.record(z.string(), z.unknown()).optional().describe('参数，未给的取默认值'),
        name: z.string().max(100).optional().describe('卡片标题，便于在提示词里 @ 引用'),
        inputs: z
          .array(
            z.object({
              from: id.describe('上游元素 id'),
              from_port: z.string().optional().describe('上游输出端口，不填自动选择'),
              to_port: z.string().optional().describe('本节点输入端口，不填按类型自动选择'),
            }),
          )
          .optional(),
        ...position,
      }),
      run: (a) =>
        withDoc((doc) => {
          const owned = host.registry.latestNode(a.type)
          if (!owned) throw new ToolError(`没有节点类型 ${a.type}，先用 list_node_types 查看`)
          const def = owned.def
          const desc = describeNode(def, owned.plugin)
          const params = { ...desc.defaults, ...(a.params ?? {}) }
          const check = def.params.safeParse(params)
          if (!check.success) throw new ToolError(`参数不对：${z.prettifyError(check.error)}`)
          const toPort = (p: (typeof desc.inputs)[number]): Port => ({
            id: p.id,
            label: p.label,
            type: p.type,
            ...(p.multiple ? { multiple: true } : {}),
            ...(p.required ? { required: true } : {}),
          })
          const size = nodeSize(desc.outputs[0]?.type, params)
          const elId = place(doc, a, {
            kind: 'node',
            nodeType: def.type,
            nodeVersion: def.version,
            name: a.name ?? def.title,
            params,
            ports: { inputs: desc.inputs.map(toPort), outputs: desc.outputs.map(toPort) },
            ...size,
          })
          const edges = (a.inputs ?? []).map((i) => link(doc, i.from, i.from_port, elId, i.to_port))
          return json({ id: elId, element: summarize(doc, need(doc, elId), false), edges })
        }),
    }),

    defineTool({
      name: 'create_element',
      description:
        '新建非节点元素：markdown（文字笔记 / 剧本）、frame（分组框）、image / video / audio（用已有资产 id 摆到画布上，例如把某个结果单独放出来）。',
      input: z.object({
        kind: z.enum(['markdown', 'frame', 'image', 'video', 'audio']),
        text: z.string().optional().describe('markdown 正文'),
        asset_id: z.string().optional().describe('image / video / audio 的资产 id'),
        name: z.string().max(100).optional(),
        w: z.number().positive().optional(),
        h: z.number().positive().optional(),
        ...position,
      }),
      run: (a) =>
        withDoc((doc) => {
          let size = { w: a.w ?? 320, h: a.h ?? 200 }
          if (a.kind === 'frame') size = { w: a.w ?? 800, h: a.h ?? 600 }
          if (a.kind === 'image' || a.kind === 'video' || a.kind === 'audio') {
            if (!a.asset_id) throw new ToolError(`${a.kind} 元素需要 asset_id`)
            const meta = asset(a.asset_id)
            if (meta.kind !== a.kind) throw new ToolError(`资产是 ${meta.kind}，不是 ${a.kind}`)
            size = mediaSize(a.kind, meta.width, meta.height, a.w, a.h)
          }
          const elId = place(doc, a, {
            kind: a.kind,
            name: a.name,
            text: a.kind === 'markdown' ? (a.text ?? '') : undefined,
            assetId: a.asset_id,
            ...size,
          })
          return json({ id: elId, element: summarize(doc, need(doc, elId), false) })
        }),
    }),

    defineTool({
      name: 'update_element',
      description:
        '修改元素：节点参数（按键合并，只改给出的键）、名称、Markdown 正文、位置尺寸、所属 Frame。改提示词后需要 run_node 才会出新结果。',
      input: z.object({
        id,
        params: z.record(z.string(), z.unknown()).optional(),
        name: z.string().max(100).optional(),
        text: z.string().optional().describe('替换 Markdown 正文'),
        x: z.number().optional().describe('世界坐标'),
        y: z.number().optional(),
        w: z.number().positive().optional(),
        h: z.number().positive().optional(),
        parent_id: id.nullable().optional().describe('移入 Frame；null 移出到画布根'),
      }),
      run: (a) =>
        withDoc((doc) => {
          const el = need(doc, a.id)
          if (a.params) {
            if (el.kind !== 'node') throw new ToolError('只有节点有参数')
            const def = el.nodeType ? host.registry.latestNode(el.nodeType)?.def : undefined
            if (def) {
              const check = def.params.safeParse({ ...el.params, ...a.params })
              if (!check.success) throw new ToolError(`参数不对：${z.prettifyError(check.error)}`)
            }
            setParams(doc, a.id, a.params)
          }
          if (a.text !== undefined) {
            if (el.kind !== 'markdown') throw new ToolError('只有 markdown 元素有正文')
            setText(doc, a.id, a.text)
          }
          if (a.parent_id !== undefined) setParent(doc, [a.id], a.parent_id)
          const cur = need(doc, a.id)
          const world = doc.worldRect(a.id)!
          updateElement(doc, a.id, {
            ...(a.name !== undefined ? { name: a.name } : {}),
            ...(a.x !== undefined ? { x: Math.round(cur.x + a.x - world.x) } : {}),
            ...(a.y !== undefined ? { y: Math.round(cur.y + a.y - world.y) } : {}),
            ...(a.w !== undefined ? { w: Math.round(a.w) } : {}),
            ...(a.h !== undefined ? { h: Math.round(a.h) } : {}),
          })
          return json(summarize(doc, need(doc, a.id), false))
        }),
    }),

    defineTool({
      name: 'connect',
      description:
        '把上游元素的输出连到节点的输入端口。端口不填时按类型自动匹配；单输入端口会替换已有连线。',
      input: z.object({
        from: id,
        from_port: z.string().optional(),
        to: id,
        to_port: z.string().optional(),
      }),
      run: (a) => withDoc((doc) => json(link(doc, a.from, a.from_port, a.to, a.to_port))),
    }),

    defineTool({
      name: 'disconnect',
      description: '删除连线（连线 id 见 get_canvas 的 edges）。',
      input: z.object({ edge_ids: z.array(id).min(1) }),
      run: ({ edge_ids }) =>
        withDoc((doc) => {
          removeEdges(doc, edge_ids)
          return '已删除'
        }),
    }),

    defineTool({
      name: 'delete_elements',
      description: '删除元素（连同相关连线；删除 Frame 会删掉里面的内容）。只删用户要求删的东西。',
      input: z.object({ ids: z.array(id).min(1) }),
      run: ({ ids }) =>
        withDoc((doc) => {
          for (const i of ids) need(doc, i)
          deleteElements(doc, ids)
          return `已删除 ${ids.length} 个元素`
        }),
    }),

    defineTool({
      name: 'run_node',
      description: `运行节点（调用模型生成，会产生费用）并等待结果，最多等 ${MAX_WAIT_S} 秒；超时则返回 running，之后用 wait_for_run 继续等。上游节点需要先有结果。`,
      input: z.object({
        id,
        wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
      }),
      run: async ({ id, wait_seconds }) => {
        let runId: string
        try {
          runId = env.runs.start(env.canvasId, id, env.ownerId)
        } catch (err) {
          if (err instanceof NodeRunError) throw new ToolError(err.message)
          throw err
        }
        return waitRun(id, runId, wait_seconds)
      },
    }),

    defineTool({
      name: 'wait_for_run',
      description: `继续等待节点当前这次运行，最多 ${MAX_WAIT_S} 秒。`,
      input: z.object({
        id,
        wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
      }),
      run: ({ id, wait_seconds }) => {
        const run = withDoc((doc) => need(doc, id).run)
        if (!run) throw new ToolError('这个节点还没运行过')
        return waitRun(id, run.id, wait_seconds)
      },
    }),

    defineTool({
      name: 'cancel_run',
      description: '取消节点正在进行的运行。',
      input: z.object({ id }),
      run: ({ id }) => {
        env.runs.cancel(env.canvasId, id)
        return '已取消'
      },
    }),

    defineTool({
      name: 'adopt_result',
      description: '把节点的某个历史结果设为当前采用的结果（卡片显示它，下游读取它）。',
      input: z.object({ id, result_id: id }),
      run: ({ id, result_id }) =>
        withDoc((doc) => {
          const el = need(doc, id)
          if (!el.results?.some((r) => r.id === result_id))
            throw new ToolError(`节点没有结果 ${result_id}`)
          adoptResult(doc, id, result_id)
          return '已采用'
        }),
    }),

    defineTool({
      name: 'view_media',
      description:
        '查看图片 / 视频 / 音频的内容：图片返回缩略图，视频按时间均匀抽帧，音频返回时长和台词。用来检查生成效果。传资产 id，或传元素 id（取它的素材或当前结果）。',
      input: z.object({
        asset_id: z.string().optional(),
        element_id: id.optional(),
        frames: z.number().int().min(1).max(8).default(4).describe('视频抽几帧'),
      }),
      run: async (a) => {
        const assetId =
          a.asset_id ??
          (a.element_id ? withDoc((doc) => assetOf(need(doc, a.element_id!))) : undefined)
        if (!assetId) throw new ToolError('需要 asset_id，或一个有媒体内容的 element_id')
        const meta = asset(assetId)
        const src = env.assets.originalPath(assetId)
        const info = `${meta.kind}，${meta.mime}${meta.width ? `，${meta.width}×${meta.height}` : ''}${meta.duration ? `，${meta.duration.toFixed(1)} 秒` : ''}`
        if (meta.kind === 'image') {
          return { content: [{ type: 'text', text: info }, await jpeg(sharp(src).rotate())] }
        }
        if (meta.kind === 'video') {
          if (!(await hasFfmpeg())) return `${info}；本机没有 ffmpeg，无法抽帧`
          const d = meta.duration ?? 1
          const content: ToolContent[] = [{ type: 'text', text: info }]
          for (let i = 0; i < a.frames; i++) {
            const t = (d * (i + 0.5)) / a.frames
            const { stdout } = await exec(
              ffmpegBin(),
              [
                '-v',
                'error',
                '-ss',
                t.toFixed(2),
                '-i',
                src,
                '-frames:v',
                '1',
                '-f',
                'image2pipe',
                '-c:v',
                'png',
                '-',
              ],
              { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
            )
            content.push(
              { type: 'text', text: `${t.toFixed(1)} 秒` },
              await jpeg(sharp(stdout), 640),
            )
          }
          return { content }
        }
        const caption = a.element_id
          ? withDoc((doc) => {
              const v = currentResult(need(doc, a.element_id!))?.value
              return v && 'caption' in v ? v.caption : undefined
            })
          : undefined
        return caption ? `${info}；台词：${caption}` : info
      },
    }),

    defineTool({
      name: 'edit_video',
      description:
        '用 ffmpeg 剪辑视频：截取片段、变速、去掉原声。结果是新资产，作为视频元素放在原元素旁边，原视频不变。',
      input: z.object({
        element_id: id.optional().describe('视频元素或视频节点（取当前结果）'),
        asset_id: z.string().optional(),
        start: z.number().min(0).optional().describe('入点（秒）'),
        end: z.number().positive().optional().describe('出点（秒）'),
        speed: z.number().min(0.25).max(4).optional().describe('播放速度倍数'),
        mute: z.boolean().optional().describe('去掉音轨'),
        name: z.string().max(100).optional(),
      }),
      run: async (a) => {
        if (!(await hasFfmpeg())) throw new ToolError('本机没有 ffmpeg')
        const assetId =
          a.asset_id ??
          (a.element_id ? withDoc((doc) => assetOf(need(doc, a.element_id!))) : undefined)
        if (!assetId) throw new ToolError('需要视频的 asset_id 或 element_id')
        const meta = asset(assetId)
        if (meta.kind !== 'video') throw new ToolError('只能剪辑视频')
        const dir = await env.assets.tempDir()
        const out = join(dir, 'edit.mp4')
        try {
          const args = ['-v', 'error', '-y']
          if (a.start !== undefined) args.push('-ss', String(a.start))
          if (a.end !== undefined) args.push('-to', String(a.end))
          args.push('-i', env.assets.originalPath(assetId))
          const speed = a.speed ?? 1
          if (speed !== 1) args.push('-filter:v', `setpts=${(1 / speed).toFixed(4)}*PTS`)
          if (a.mute) args.push('-an')
          else if (speed !== 1) args.push('-filter:a', atempo(speed))
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
          if (!a.mute) args.push('-c:a', 'aac')
          args.push('-movflags', '+faststart', out)
          await exec(ffmpegBin(), args, { maxBuffer: 16 * 1024 * 1024 })
          const made = await env.assets.ingest(env.ownerId, createReadStream(out), {
            mime: 'video/mp4',
            name: `${a.name ?? 'edit'}.mp4`,
          })
          return withDoc((doc) => {
            const size = mediaSize('video', made.width, made.height)
            const elId = place(
              doc,
              { near: a.element_id },
              {
                kind: 'video',
                assetId: made.id,
                name: a.name ?? '剪辑',
                ...size,
              },
            )
            return json({ id: elId, asset_id: made.id, duration: made.duration })
          })
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      },
    }),
  ]

  async function waitRun(nodeId: string, runId: string, seconds: number) {
    const status = await Promise.race([
      env.runs.wait(runId),
      new Promise<'running'>((r) => setTimeout(() => r('running'), seconds * 1000)),
    ])
    return withDoc((doc) => {
      const el = need(doc, nodeId)
      const run = el.run?.id === runId ? el.run : undefined
      const results = (el.results ?? []).filter((r) => r.runId === runId).map(resultSummary)
      return json({
        status,
        ...(run?.progress !== undefined && status === 'running' ? { progress: run.progress } : {}),
        ...(run?.error ? { error: run.error } : {}),
        ...(run?.message && status === 'running' ? { message: run.message } : {}),
        results,
      })
    })
  }

  /** 解析放置位置并建元素 */
  function place(
    doc: PleinDoc,
    a: { near?: string; x?: number; y?: number; parent_id?: string },
    input: Omit<NewElement, 'x' | 'y'> & { w: number; h: number },
  ): string {
    let world: { x: number; y: number }
    if (a.x !== undefined && a.y !== undefined) world = { x: a.x, y: a.y }
    else world = freeSpot(doc, input, a.near ? doc.worldRect(a.near) : undefined)
    const parentId = a.parent_id ?? (a.near ? (doc.get(a.near)?.parentId ?? null) : null)
    if (parentId && doc.get(parentId)?.kind !== 'frame')
      throw new ToolError(`${parentId} 不是 Frame`)
    const origin = parentId ? (doc.worldRect(parentId) ?? { x: 0, y: 0 }) : { x: 0, y: 0 }
    return createElement(doc, {
      ...input,
      parentId,
      x: Math.round(world.x - origin.x),
      y: Math.round(world.y - origin.y),
    } as NewElement)
  }

  function link(
    doc: PleinDoc,
    fromId: string,
    fromPort: string | undefined,
    toId: string,
    toPort: string | undefined,
  ) {
    const from = elementPorts(need(doc, fromId))
    const to = elementPorts(need(doc, toId))
    if (!from?.outputs.length) throw new ToolError(`${fromId} 没有输出端口（素材元素需要有内容）`)
    if (!to?.inputs.length) throw new ToolError(`${toId} 没有输入端口`)
    const outs = fromPort ? from.outputs.filter((p) => p.id === fromPort) : from.outputs
    if (!outs.length) throw new ToolError(`${fromId} 没有输出端口 ${fromPort}`)
    let pair: [Port, Port] | undefined
    for (const o of outs) {
      const ins = toPort ? to.inputs.filter((p) => p.id === toPort) : to.inputs
      const i = ins.find((p) => portsCompatible(o.type, p.type))
      if (i) {
        pair = [o, i]
        break
      }
    }
    if (!pair) {
      const list = to.inputs.map((p) => `${p.id}(${p.type})`).join('、')
      throw new ToolError(`端口类型对不上：${toId} 的输入端口有 ${list}`)
    }
    const edge = connect(doc, [fromId, pair[0].id], [toId, pair[1].id])
    return edge
      ? `${edge.id}: ${fromId}.${pair[0].id} → ${toId}.${pair[1].id}`
      : `已连接：${fromId}.${pair[0].id} → ${toId}.${pair[1].id}`
  }
}

function json(v: unknown) {
  return JSON.stringify(v, null, 1)
}

const clip = (s: string, n = LONG_TEXT) =>
  s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字）` : s

function resultSummary(r: NodeResult) {
  const v = r.value
  const base = { result_id: r.id, port: r.port, type: v.type }
  if (v.type === 'text') return { ...base, text: clip(v.text) }
  if (v.type === 'json') return { ...base, value: clip(JSON.stringify(v.value)) }
  return { ...base, asset_id: v.assetId, ...(v.caption ? { caption: v.caption } : {}) }
}

/** 给模型看的元素摘要；full 时不截断并带上全部历史结果 */
function summarize(doc: PleinDoc, el: CanvasElement, full: boolean) {
  const r = doc.worldRect(el.id)!
  const out: Record<string, unknown> = {
    id: el.id,
    kind: el.kind,
    ...(el.name ? { name: el.name } : {}),
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)],
  }
  const parent = doc.effectiveParent(el)
  if (parent) out.parent = parent
  if (el.text !== undefined) out.text = full ? el.text : clip(el.text)
  if (el.assetId) out.asset_id = el.assetId
  if (el.kind === 'node') {
    out.type = el.nodeType
    out.params = full
      ? el.params
      : Object.fromEntries(
          Object.entries(el.params ?? {}).map(([k, v]) => [k, typeof v === 'string' ? clip(v) : v]),
        )
    const ports = elementPorts(el)
    if (ports) {
      out.inputs = ports.inputs.map((p) => `${p.id}:${p.type}${p.multiple ? '[]' : ''}`)
      out.outputs = ports.outputs.map((p) => `${p.id}:${p.type}`)
    }
    if (el.run) {
      out.run = {
        status: el.run.status,
        ...(el.run.error ? { error: el.run.error } : {}),
        ...(el.run.progress !== undefined ? { progress: el.run.progress } : {}),
      }
    }
    const cur = currentResult(el)
    if (cur) out.current_result = resultSummary(cur)
    if (full && el.results?.length) out.results = el.results.map(resultSummary)
    else if (el.results && el.results.length > 1) out.result_count = el.results.length
  }
  return out
}

/** 元素自身的素材，或节点当前采用的媒体结果 */
function assetOf(el: CanvasElement): string | undefined {
  if (el.assetId) return el.assetId
  const v = currentResult(el)?.value
  return v && 'assetId' in v ? v.assetId : undefined
}

function overlaps(a: Rect, b: Rect, pad: number) {
  return (
    a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y
  )
}

/** 找一块不和顶层元素重叠的空位：参照元素右侧，没有参照时放在全部内容右侧 */
function freeSpot(doc: PleinDoc, size: { w: number; h: number }, anchor?: Rect) {
  const roots = doc.children(null).map((e) => doc.worldRect(e.id)!)
  let start: { x: number; y: number }
  if (anchor) start = { x: anchor.x + anchor.w + GAP, y: anchor.y }
  else if (roots.length) {
    const maxX = Math.max(...roots.map((r) => r.x + r.w))
    const minY = Math.min(...roots.map((r) => r.y))
    start = { x: maxX + GAP * 1.5, y: minY }
  } else start = { x: 0, y: 0 }
  const rect = { ...start, ...size }
  for (let i = 0; i < 60 && roots.some((r) => overlaps(rect, r, GAP / 2)); i++) {
    rect.y += Math.max(size.h, 120) / 2
  }
  return { x: rect.x, y: rect.y }
}

/** 与前端 nodeElement 一致：出图 / 视频按画幅取形状 */
function nodeSize(out: string | undefined, params: Record<string, unknown>) {
  if (out === 'image' || out === 'video') {
    const m = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(String(params.aspectRatio ?? ''))
    const ratio = m ? Number(m[1]) / Number(m[2]) : 1
    return ratio >= 1
      ? { w: 400, h: Math.round(400 / ratio) }
      : { w: Math.round(400 * ratio), h: 400 }
  }
  if (out === 'audio') return { w: 300, h: 160 }
  return { w: 280, h: 200 }
}

function mediaSize(kind: string, width?: number, height?: number, w?: number, h?: number) {
  if (w && h) return { w, h }
  if (kind === 'audio') return { w: 320, h: 96 }
  const ratio = width && height ? width / height : 16 / 9
  if (w) return { w, h: Math.round(w / ratio) }
  return ratio >= 1
    ? { w: 400, h: Math.round(400 / ratio) }
    : { w: Math.round(400 * ratio), h: 400 }
}

/** atempo 单级只支持 0.5–2，超出时串联 */
function atempo(speed: number) {
  const parts: string[] = []
  let s = speed
  while (s > 2) {
    parts.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  parts.push(`atempo=${s.toFixed(4)}`)
  return parts.join(',')
}

async function jpeg(img: Sharp, size = 768): Promise<ToolContent> {
  const buf = await img
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }
}
