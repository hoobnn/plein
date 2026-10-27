import type { Engine } from '@plein/canvas-core'
import { connect, createElement, type NewElement, setParams } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { animaticNode, sequenceNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { resetStoreAfterEach } from '../../testing/render'

resetStoreAfterEach(useCatalog)

/** 保留真实文档、参数与 store；仅提供编辑器需要的画布引擎事件边界。 */
export function sequenceFixture(
  options: {
    animatic?: boolean
    params?: Record<string, unknown>
    videos?: string[]
  } = {},
) {
  const doc = openDoc()
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const engine = {
    doc,
    onStateChange: subscribe,
    selection: { onChange: subscribe, set: () => {}, ids: [] },
    undo: () => {
      doc.undo.undo()
      doc.flush()
    },
    redo: () => {
      doc.undo.redo()
      doc.flush()
    },
  } as unknown as Engine
  const definition = options.animatic ? animaticNode : sequenceNode
  const descriptor = describeNode(definition, 'plein/core')
  const add = (element: Partial<NewElement>) =>
    createElement(doc, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 320,
      h: 180,
      ...element,
    })
  const id = add({
    name: '测试序列',
    nodeType: definition.type,
    nodeVersion: definition.version,
    ports: { inputs: descriptor.inputs, outputs: descriptor.outputs },
    params: {
      subtitles: false,
      ...(options.animatic
        ? { shots: [{ shotId: 'one', duration: 3, dialogue: [] }] }
        : { instanceVersion: 2, clips: [] }),
      ...options.params,
    },
  })
  const sources = (options.videos ?? []).map((assetId, index) => {
    const source = add({ kind: 'video', name: `视频 ${index + 1}`, assetId })
    connect(doc, [source, 'video'], [id, 'clips'])
    return source
  })
  doc.flush()
  doc.undo.clear()
  useCatalog.setState({
    catalog: {
      plugins: [],
      providers: [],
      defaultModels: {},
      templates: [],
      prompts: [],
      elements: [],
      nodes: [sequenceNode, animaticNode].map((node) => ({
        ...describeNode(node, 'plein/core'),
        executable: true,
      })),
    },
  })
  useCanvas.setState({ engine, canvasId: 'sequence-test-canvas', sequence: id })
  useSession.setState({
    status: 'ready',
    info: {
      principal: { id: 'owner', role: 'owner' },
      authRequired: false,
      needsSetup: false,
    },
  })
  return {
    doc,
    engine,
    id,
    sources,
    add,
    params: () => doc.get(id)!.params!,
    patch: (patch: Record<string, unknown>) => {
      setParams(doc, id, patch)
      doc.flush()
    },
    refresh: () => {
      doc.flush()
      for (const listener of listeners) listener()
    },
  }
}
