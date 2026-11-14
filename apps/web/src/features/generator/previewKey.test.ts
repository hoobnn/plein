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
