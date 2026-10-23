import { connect, createElement, deleteElements, inputEdges } from '@plein/doc'
import {
  definePlugin,
  definePluginCapability,
  defineServerPlugin,
  PLUGIN_API_VERSION,
} from '@plein/plugin-sdk'
import type { PreparedInput } from '@plein/protocol'
import { beforeAll, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'
import { addNode, bootServer, createCanvas } from '../testing'
import { callTool, type McpTool, type ToolResult } from './mcp'
import { canvasTools, type ToolEnv } from './tools'
import { AgentChanges } from './changes'

let running: Awaited<ReturnType<typeof bootServer>>
beforeAll(async () => {
  running = await bootServer()
  running.server.plugins.load(
    [
      defineServerPlugin(
        definePlugin({
          manifest: {
            id: 'acme/selection',
            version: '1.0.0',
            name: 'selection',
            engines: { plein: `^${PLUGIN_API_VERSION}` },
            contributes: { capabilities: ['acme/selection'] },
          },
        }),
        {
          capabilities: [
            definePluginCapability({
              id: 'acme/selection',
              title: 'selection',
              description: '',
              effect: 'read',
              input: z.object({}),
              run: (ctx) => {
                const selection = [...ctx.selection]
                ctx.selection.push('plugin-local')
                return { selection }
              },
            }),
          ],
        },
      ),
    ],
    false,
  )
})
afterEach(() => vi.restoreAllMocks())

function env(canvasId: string, selection?: string[]): ToolEnv {
  const { rooms, runs, plugins, assets, library } = running.server
  return { canvasId, ownerId: 'local', rooms, runs, host: plugins, assets, library, selection }
}

interface Page {
  version: string
  value: unknown
  total: number
  complete: boolean
  next_offset?: number
  next_text_offset?: number
}
async function read(tools: McpTool[], name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(
    tools.find((tool) => tool.name === name)!,
    args,
  )
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { result, text, json: <T = Page>() => JSON.parse(text) as T }
}
const expectBounded = (result: ToolResult) => {
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24 * 1024)
}

describe('canvas AI integration', () => {
  it('records reference reorder and replacement in the same agent turn and undoes both together', async () => {
    const { id, doc } = await createCanvas(running.server)
    const { rooms, runs } = running.server
    const changes = new AgentChanges('reference-test', id, 'local', rooms, runs)
    try {
      const images = ['first', 'last', 'replacement'].map((assetId) =>
        createElement(doc, { kind: 'image', assetId, x: 0, y: 0, w: 100, h: 100 }),
      )
      const target = addNode(doc, 'plein/video')
      const edges = images
        .slice(0, 2)
        .map((image) => connect(doc, [image, 'image'], [target, 'images'])!)
      const before = inputEdges(doc, target, 'images')
      changes.begin('reference-turn')
      const tools = canvasTools({ ...env(id), origin: changes.origin })
      const reordered = await read(tools, 'reorder_inputs', {
        id: target,
        port: 'images',
        edge_ids: [edges[1]!.id, edges[0]!.id],
      })
      expect(reordered.result.isError).not.toBe(true)
      const replaced = await read(tools, 'replace_input', {
        edge_id: edges[1]!.id,
        from: images[2],
        from_port: 'image',
      })
      expect(replaced.result.isError).not.toBe(true)
      expect(doc.getEdge(edges[1]!.id)?.from).toEqual([images[2], 'image'])
      changes.end()
      expect(changes.undoTurn('reference-turn')).toBe(true)
      expect(inputEdges(doc, target, 'images')).toEqual(before)
      expect(images.every((image) => doc.has(image))).toBe(true)
    } finally {
      changes.release()
      doc.destroy()
    }
  })

  it('inspects real prepared inputs without starting a job or calling a provider', async () => {
    const { id, doc } = await createCanvas(running.server)
    try {
      const node = addNode(doc, 'plein/image', { params: { prompt: '清晨的湖面' } })
      const tools = canvasTools(env(id))
      const start = vi.spyOn(running.server.runs, 'start')
      const call = vi.spyOn(running.server.plugins, 'call')
      const root = await read(tools, 'inspect_node_input', { id: node })
      expect(root.result.isError).not.toBe(true)
      expect(root.json()).toMatchObject({ status: 'ready', inputHash: expect.any(String) })
      const prompt = await read(tools, 'inspect_node_input', { id: node, field_path: '/prompt' })
      expect(prompt.json()).toMatchObject({ type: 'string', value: '清晨的湖面', complete: true })
      const model = await read(tools, 'inspect_node_input', { id: node, field_path: '/model/ref' })
      expect(model.json().value).toBe('plein/mock:image')
      expect(start).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
      expect(doc.get(node)?.run).toBeUndefined()
      expectBounded(root.result)
      const missing = await read(tools, 'inspect_node_input', { id: 'missing' })
      expect(missing.result.isError).toBe(true)
      expect(missing.text).toContain('节点不存在')
    } finally {
      doc.destroy()
    }
  })

  it('pages full prompt and structured fields with stable versions, bounded output and explicit previews', async () => {
    const text = '原文🎬"\n'.repeat(15000)
    let prepared: PreparedInput = {
      v: 1,
      nodeId: 'node',
      nodeType: 'plein/image',
      preparedAt: 1,
      status: 'blocked',
      inputHash: 'hash-a',
      model: { ref: 'provider:model', provider: 'provider', title: 'Model' },
      prompt: text,
      params: { long: text, 'a/b~c': { raw: text } },
      inputs: {},
      refs: Array.from({ length: 150 }, (_, i) => ({
        elementId: `ref-${i}`,
        name: `参考 ${i}`,
        kind: 'image',
        required: false,
        available: ['asset'],
        sent: ['asset'],
      })),
      notices: [{ code: 'model_access_unverified', message: '权限待验证' }],
      blocked: [{ code: 'prepare_failed', message: '参考缺失' }],
    }
    vi.spyOn(running.server.runs, 'preview').mockImplementation(async () => ({
      ...prepared,
      preparedAt: Date.now(),
    }))
    const { id, doc } = await createCanvas(running.server)
    try {
      const tools = canvasTools(env(id))
      const root = await read(tools, 'inspect_node_input', { id: 'node' })
      expectBounded(root.result)
      expect(root.json()).toMatchObject({ status: 'blocked', inputHash: 'hash-a' })
      expect(root.json().value).toContainEqual(
        expect.objectContaining({
          key: 'prompt',
          field_path: '/prompt',
          value: expect.objectContaining({ complete: false }),
        }),
      )
      let full = '',
        offset = 0
      do {
        const out = await read(tools, 'inspect_node_input', {
          id: 'node',
          field_path: '/prompt',
          text_offset: offset,
          text_limit: 8000,
          expected_version: root.json().version,
        })
        expect(out.result.isError).not.toBe(true)
        expectBounded(out.result)
        full += out.json().value as string
        offset = out.json().next_text_offset ?? -1
      } while (offset >= 0)
      expect(full).toBe(text)

      let refs = 0,
        next = 0
      do {
        const out = await read(tools, 'inspect_node_input', {
          id: 'node',
          field_path: '/refs',
          offset: next,
          limit: 40,
          expected_version: root.json().version,
        })
        expectBounded(out.result)
        refs += (out.json().value as unknown[]).length
        next = out.json().next_offset ?? -1
      } while (next >= 0)
      expect(refs).toBe(150)
      for (const [field_path, value] of [
        ['/model/ref', 'provider:model'],
        ['/notices/0/message', '权限待验证'],
        ['/blocked/0/message', '参考缺失'],
      ])
        expect(
          (await read(tools, 'inspect_node_input', { id: 'node', field_path })).json().value,
        ).toBe(value)
      expect(
        (
          await read(tools, 'inspect_node_input', { id: 'node', field_path: '/params/a~1b~0c/raw' })
        ).json().value,
      ).toBe(text.slice(0, 4000))
      expect(
        (await read(tools, 'inspect_node_input', { id: 'node', field_path: '/refs', offset: 1 }))
          .text,
      ).toContain('expected_version_required')
      expect(
        (await read(tools, 'inspect_node_input', { id: 'node', field_path: '/__proto__' })).text,
      ).toContain('field_missing')
      expect(
        (await read(tools, 'inspect_node_input', { id: 'node', field_path: '/~broken' })).text,
      ).toContain('invalid_field_path')
      prepared = { ...prepared, inputHash: 'hash-b', prompt: 'changed' }
      const changed = await read(tools, 'inspect_node_input', {
        id: 'node',
        field_path: '/prompt',
        text_offset: 1,
        expected_version: root.json().version,
      })
      expect(changed.result.isError).toBe(true)
      expect(changed.text).toContain('input_changed')
    } finally {
      doc.destroy()
    }
  })

  it('binds request selection for built-in and plugin tools, including empty and deleted targets', async () => {
    const { id, doc } = await createCanvas(running.server)
    try {
      const first = createElement(doc, {
        kind: 'markdown',
        name: '发送目标',
        text: '原文',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      })
      const other = createElement(doc, {
        kind: 'markdown',
        name: '实时选区',
        x: 200,
        y: 0,
        w: 100,
        h: 100,
      })
      const selection = [first, first]
      const tools = canvasTools(env(id, selection))
      selection.splice(0, selection.length, other)
      running.server.rooms.get(id).awareness.setLocalState({
        view: {
          selection: [other],
          viewport: { x: 0, y: 0, w: 800, h: 600 },
          at: Date.now(),
        },
      })
      expect((await read(tools, 'ui_get_selection')).json()).toMatchObject({
        source: 'request',
        total: 1,
        elements: [{ id: first, kind: 'markdown', name: '发送目标' }],
        missing: [],
      })
      expect((await read(tools, 'acme__selection')).json()).toEqual({ selection: [first] })
      expect((await read(tools, 'acme__selection')).json()).toEqual({ selection: [first] })
      const empty = canvasTools(env(id))
      expect((await read(empty, 'ui_get_selection')).json()).toMatchObject({
        total: 0,
        elements: [],
      })
      expect((await read(empty, 'acme__selection')).json()).toEqual({ selection: [] })
      deleteElements(doc, [first])
      expect((await read(tools, 'ui_get_selection')).json()).toMatchObject({
        total: 1,
        elements: [],
        missing: [first],
      })
      expect((await read(tools, 'acme__selection')).json()).toEqual({ selection: [first] })
    } finally {
      doc.destroy()
    }
  })
})
