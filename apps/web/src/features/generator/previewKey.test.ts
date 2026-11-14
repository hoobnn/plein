import {
  addResults,
  adoptResult,
  connect,
  createElement,
  inputEdges,
  type PleinDoc,
  moveElements,
  reorderInputs,
  setParam,
  setText,
  updateElement,
  writeRun,
} from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import type { Engine } from '@plein/canvas-core'
import { afterEach, expect, it } from 'vite-plus/test'
import { previewInputKey } from './previewKey'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const imagePorts = {
  inputs: [
    { id: 'references', label: '参考图', type: 'image' as const, multiple: true },
    { id: 'prompt', label: '文本', type: 'text' as const },
  ],
  outputs: [{ id: 'image', label: '图片', type: 'image' as const }],
}

/** 一张镜头：提示词 @ 了角色卡，还连了一段上游文本 */
function fixture() {
  const doc = openDoc()
  docs.push(doc)
  const engine = { doc } as Engine
  const script = createElement(
    doc,
    node({
      nodeType: 'llm',
      name: '剧本',
      ports: {
        inputs: [{ id: 'in', label: '输入', type: 'text' }],
        outputs: [{ id: 'out', label: '输出', type: 'text' }],
      },
    }),
  )
  const markdown = createElement(doc, {
    kind: 'markdown',
    text: '第一幕：天台',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
  } as never)
  const card = createElement(
    doc,
    node({
      nodeType: 'plein/character',
      name: '林夏',
      params: { description: '黑发', voiceId: 'v1' },
      ports: {
        inputs: [{ id: 'references', label: '定妆图', type: 'image', multiple: true }],
        outputs: [{ id: 'image', label: '参考图', type: 'image' }],
      },
    }),
  )
  const look = createElement(doc, box({ name: '林夏定妆图', assetId: 'look-a' }))
  connect(doc, [look, 'image'], [card, 'references'])
  const shot = createElement(
    doc,
    node({
      nodeType: 'plein/image',
      name: '镜头',
      params: { prompt: '@林夏 推门', model: 'p/mock:image' },
      ports: imagePorts,
    }),
  )
  connect(doc, [markdown, 'text'], [shot, 'prompt'])
  // 画布上还有一张没被引用的命名图片：它的素材换掉不该影响这张镜头的预览
  const prop = createElement(doc, box({ name: '台灯', assetId: 'lamp-a' }))
  doc.flush()
  const key = () => {
    doc.flush()
    return previewInputKey(engine, shot)
  }
  return { doc, engine, script, markdown, card, look, shot, prop, key }
}

it('无关的移动、进度和别的命名图片都不改变预览摘要', () => {
  const f = fixture()
  const before = f.key()
  moveElements(f.doc, [f.shot, f.card, f.prop], 900, -400)
  writeRun(f.doc, f.card, { id: 'run-x', status: 'running', at: 1, progress: 0.4 })
  updateElement(f.doc, f.prop, { assetId: 'lamp-b' })
  setParam(f.doc, f.prop, 'note', '换了一盏灯')
  expect(f.key()).toBe(before)
})

it('本节点提示词、模型与上游文本变化都会重取预览', () => {
  const f = fixture()
  const before = f.key()
  setParam(f.doc, f.shot, 'prompt', '@林夏 跑上天台')
  expect(f.key()).not.toBe(before)
  const afterPrompt = f.key()
  setParam(f.doc, f.shot, 'model', 'p/mock:other')
  expect(f.key()).not.toBe(afterPrompt)
  const afterModel = f.key()
  setText(f.doc, f.markdown, '第二幕：天台')
  expect(f.key()).not.toBe(afterModel)
})

it('上游采用与输入顺序变化会重取预览，上游多出来的候选不会', () => {
  const f = fixture()
  const generated = createElement(
    f.doc,
    node({
      nodeType: 'llm',
      name: '台词',
      ports: {
        inputs: [{ id: 'in', label: '输入', type: 'text' }],
        outputs: [{ id: 'out', label: '输出', type: 'text' }],
      },
    }),
  )
  connect(f.doc, [generated, 'out'], [f.shot, 'prompt'])
  addResults(
    f.doc,
    generated,
    [
      {
        id: 'res-a',
        port: 'out',
        runId: 'run-a',
        at: 1,
        value: { type: 'text', text: '第一版台词' },
      },
      {
        id: 'res-b',
        port: 'out',
        runId: 'run-b',
        at: 2,
        value: { type: 'text', text: '第二版台词' },
      },
    ],
    { adopt: false },
  )
  f.doc.flush()
  const unadopted = f.key()
  adoptResult(f.doc, generated, 'res-b')
  const adopted = f.key()
  expect(adopted).not.toBe(unadopted)
  // 只多一个没采用的候选：当前输入没变
  addResults(
    f.doc,
    generated,
    [{ id: 'res-c', port: 'out', runId: 'run-c', at: 3, value: { type: 'text', text: '第三版' } }],
    { adopt: false },
  )
  expect(f.key()).toBe(adopted)

  // 参考图的顺序换了
  const firstLook = createElement(f.doc, box({ name: '侧脸', assetId: 'look-side' }))
  const secondLook = createElement(f.doc, box({ name: '正面', assetId: 'look-front' }))
  connect(f.doc, [firstLook, 'image'], [f.shot, 'references'])
  connect(f.doc, [secondLook, 'image'], [f.shot, 'references'])
  f.doc.flush()
  const two = f.key()
  const ids = inputEdges(f.doc, f.shot, 'references').map((e) => e.id)
  expect(ids).toHaveLength(2)
  expect(reorderInputs(f.doc, [f.shot, 'references'], [...ids].reverse())).toBe(true)
  expect(f.key()).not.toBe(two)
})

it('已生成的上游只消费结果：编辑它没运行的草稿不刷新下游预览，换采用仍会', () => {
  const f = fixture()
  const generated = createElement(
    f.doc,
    node({
      nodeType: 'llm',
      name: '台词',
      ports: {
        inputs: [{ id: 'in', label: '输入', type: 'text' }],
        outputs: [{ id: 'out', label: '输出', type: 'text' }],
      },
    }),
  )
  connect(f.doc, [generated, 'out'], [f.shot, 'prompt'])
  addResults(
    f.doc,
    generated,
    [
      { id: 'res-a', port: 'out', runId: 'run-a', at: 1, value: { type: 'text', text: '第一版' } },
      { id: 'res-b', port: 'out', runId: 'run-b', at: 2, value: { type: 'text', text: '第二版' } },
    ],
    { adopt: false },
  )
  adoptResult(f.doc, generated, 'res-a')
  f.doc.flush()
  const before = f.key()

  // 上游已经生成：编辑它还没运行的提示词草稿，不改变下游实际输入
  setParam(f.doc, generated, 'prompt', '还没跑的新草稿')
  expect(f.key()).toBe(before)

  // 换用另一个候选：下游拿到的结果变了
  adoptResult(f.doc, generated, 'res-b')
  expect(f.key()).not.toBe(before)
})

it('还没出结果的上游草稿与真正内联的文本仍参与预览', () => {
  const f = fixture()
  const pending = createElement(
    f.doc,
    node({
      nodeType: 'plein/image',
      name: '上游待生成',
      params: { prompt: '上游草稿' },
      ports: {
        inputs: [],
        outputs: [{ id: 'image', label: '图片', type: 'image' }],
      },
    }),
  )
  connect(f.doc, [pending, 'image'], [f.shot, 'references'])
  f.doc.flush()
  const before = f.key()
  setParam(f.doc, pending, 'prompt', '上游草稿改了')
  expect(f.key()).not.toBe(before)

  // 内联文本（没有结果）直接就是输入：接到提示词端口后改正文
  const inline = createElement(f.doc, box({ kind: 'markdown', text: '第一幕' }))
  connect(f.doc, [inline, 'text'], [f.shot, 'prompt'])
  f.doc.flush()
  const afterText = f.key()
  setText(f.doc, inline, '第二幕：天台')
  expect(f.key()).not.toBe(afterText)
})

it('@ 到的图片换素材、角色连入的定妆图换素材或采用都会重取预览', () => {
  const f = fixture()
  const before = f.key()
  // 角色卡连入的定妆图换成另一张素材
  updateElement(f.doc, f.look, { assetId: 'look-b' })
  const lookChanged = f.key()
  expect(lookChanged).not.toBe(before)
  // 定妆图直接引用的命名图片被换掉
  const direct = createElement(f.doc, box({ name: '外景', assetId: 'scene-a' }))
  connect(f.doc, [direct, 'image'], [f.card, 'references'])
  f.doc.flush()
  const withDirect = f.key()
  updateElement(f.doc, direct, { assetId: 'scene-b' })
  expect(f.key()).not.toBe(withDirect)
  // 角色卡参数（音色、档案）变了
  const beforeVoice = f.key()
  setParam(f.doc, f.card, 'voiceId', 'v2')
  expect(f.key()).not.toBe(beforeVoice)
})

it('提示词直接 @ 的命名图片换素材会重取预览', () => {
  const f = fixture()
  const named = createElement(f.doc, box({ name: '外景', assetId: 'scene-a' }))
  setParam(f.doc, f.shot, 'prompt', '@林夏 在@外景 推门')
  f.doc.flush()
  const before = f.key()
  updateElement(f.doc, named, { assetId: 'scene-b' })
  expect(f.key()).not.toBe(before)
})

it('@ 卡片连入的已生成定妆图只用结果：草稿不刷新，换采用与失败状态仍会', () => {
  const f = fixture()
  const look = createElement(
    f.doc,
    node({
      nodeType: 'plein/image',
      name: '定妆图生成器',
      params: { prompt: '定妆图草稿', model: 'p/mock:image' },
      ports: {
        inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
        outputs: [{ id: 'images', label: '图片', type: 'image' }],
      },
    }),
  )
  addResults(f.doc, look, [
    {
      id: 'look-a',
      port: 'images',
      runId: 'run-look-a',
      at: 1,
      value: { type: 'image', assetId: 'l'.repeat(64) },
    },
    {
      id: 'look-b',
      port: 'images',
      runId: 'run-look-b',
      at: 2,
      value: { type: 'image', assetId: 'm'.repeat(64) },
    },
  ])
  connect(f.doc, [look, 'images'], [f.card, 'references'])
  f.doc.flush()
  const before = f.key()

  // 定妆图生成器已经出图：编辑它还没运行的提示词草稿，不改变卡片实际提供的参考图
  setParam(f.doc, look, 'prompt', '换了但还没跑')
  expect(f.key()).toBe(before)
  // 换用另一个定妆候选：卡片提供的参考图变了
  adoptResult(f.doc, look, 'look-b')
  const adopted = f.key()
  expect(adopted).not.toBe(before)
  // 上游进度不算语义变化
  writeRun(f.doc, look, { id: 'run-look-b', status: 'running', at: 3, progress: 0.6 })
  expect(f.key()).toBe(adopted)
})

it('@ 卡片还没有定妆结果时，失败状态与草稿仍会刷新预览', () => {
  const f = fixture()
  const pendingLook = createElement(
    f.doc,
    node({
      nodeType: 'plein/image',
      name: '待生成定妆',
      params: { prompt: '定妆草稿' },
      ports: {
        inputs: [],
        outputs: [{ id: 'images', label: '图片', type: 'image' }],
      },
    }),
  )
  connect(f.doc, [pendingLook, 'images'], [f.card, 'references'])
  f.doc.flush()
  const before = f.key()
  setParam(f.doc, pendingLook, 'prompt', '定妆草稿改了')
  expect(f.key()).not.toBe(before)

  // 进度写回不算语义变化
  writeRun(f.doc, pendingLook, { id: 'run-look', status: 'running', at: 1, progress: 0.4 })
  const drafting = f.key()
  writeRun(f.doc, pendingLook, { id: 'run-look', status: 'running', at: 2, progress: 0.8 })
  expect(f.key()).toBe(drafting)
  // 失败原因会改变服务端的提示/阻断
  writeRun(f.doc, pendingLook, {
    id: 'run-look',
    status: 'failed',
    at: 3,
    error: '平台审核未通过',
  })
  expect(f.key()).not.toBe(drafting)
})

it('跨画布失效绑定遮蔽同名素材：改同名图不刷新，改绑定或普通 @ 仍会', () => {
  const doc = openDoc()
  docs.push(doc)
  const engine = { doc } as Engine
  const look = createElement(doc, box({ name: '图', assetId: 'c'.repeat(64) }))
  const binding = `referenceNameBinding:${encodeURIComponent('图')}:external-source`
  const consumer = createElement(
    doc,
    node({
      nodeType: 'plein/llm',
      name: '看图说话',
      params: {
        prompt: '看 @图',
        [binding]: { type: 'image', assetId: '', source: 'external-source' },
      },
    }),
  )
  const key = () => {
    doc.flush()
    return previewInputKey(engine, consumer)
  }
  const before = key()
  // 目标画布上的同名图换了素材：服务端这批绑定根本没送出去，实际输入没变
  updateElement(doc, look, { assetId: 'd'.repeat(64) })
  expect(key()).toBe(before)
  // 绑定本身变了仍是实际输入变化
  setParam(doc, consumer, binding, { type: 'image', assetId: '', source: 'another-source' })
  expect(key()).not.toBe(before)
  // 去掉失效绑定后，@图 变成真正生效的普通引用
  const unbound = createElement(
    doc,
    node({ nodeType: 'plein/llm', name: '没有绑定', params: { prompt: '看 @图' } }),
  )
  doc.flush()
  const plain = previewInputKey(engine, unbound)
  updateElement(doc, look, { assetId: 'e'.repeat(64) })
  expect(previewInputKey(engine, unbound)).not.toBe(plain)
})

it('参考模式下绑定的本画布来源仍按消费结果追踪：草稿不刷新，换采用会', () => {
  const f = fixture()
  const bound = createElement(
    f.doc,
    node({
      nodeType: 'plein/image',
      name: '绑定的来源',
      params: { prompt: '来源草稿', model: 'p/mock:image' },
      ports: {
        inputs: [],
        outputs: [{ id: 'images', label: '图片', type: 'image' }],
      },
    }),
  )
  addResults(f.doc, bound, [
    {
      id: 'bound-a',
      port: 'images',
      runId: 'run-bound-a',
      at: 1,
      value: { type: 'image', assetId: 'n'.repeat(64) },
    },
    {
      id: 'bound-b',
      port: 'images',
      runId: 'run-bound-b',
      at: 2,
      value: { type: 'image', assetId: 'o'.repeat(64) },
    },
  ])
  const binding = `referenceNameBinding:${encodeURIComponent('定妆')}:${bound}`
  setParam(f.doc, f.shot, 'prompt', '@定妆 推门')
  setParam(f.doc, f.shot, binding, {
    type: 'image',
    assetId: 'n'.repeat(64),
    source: bound,
    sourcePort: 'images',
  })
  f.doc.flush()
  const before = f.key()
  // 来源已经出图：编辑它未运行的草稿不影响这次的实际输入
  setParam(f.doc, bound, 'prompt', '来源草稿改了')
  expect(f.key()).toBe(before)
  // 换用来源的另一个候选：实际送入的素材变了
  adoptResult(f.doc, bound, 'bound-b')
  expect(f.key()).not.toBe(before)
})

it('只有被提示词命中的名字才参与摘要：无关目标改名不影响，重名会让预览刷新', () => {
  const f = fixture()
  const before = f.key()
  // 没被 @ 的命名图片改名
  updateElement(f.doc, f.prop, { name: '落地灯' })
  expect(f.key()).toBe(before)
  // 被 @ 的角色卡改名：提示词不再命中
  const named = f.key()
  updateElement(f.doc, f.card, { name: '林夏夏' })
  const renamed = f.key()
  expect(renamed).not.toBe(named)
  // 新加一张同名卡：@林夏 变成歧义
  const twin = createElement(
    f.doc,
    node({
      nodeType: 'plein/character',
      name: '林夏',
      params: { description: '短发' },
      ports: {
        inputs: [{ id: 'references', label: '定妆图', type: 'image', multiple: true }],
        outputs: [{ id: 'image', label: '参考图', type: 'image' }],
      },
    }),
  )
  expect(f.key()).not.toBe(renamed)
  expect(twin).toBeTruthy()
})
