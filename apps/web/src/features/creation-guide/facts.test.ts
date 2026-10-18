import {
  addResults,
  adoptResult,
  connect,
  createDoc,
  createElement,
  deleteElements,
  creativeReviewTarget,
  recordCreativeReview,
  setParams,
  updateElement,
  writeRun,
  type DeliveryRecord,
  type PleinDoc,
  type ResultValue,
} from '@plein/doc'
import { Shot, STORYBOARD_TYPE, SEQUENCE_TYPE } from '@plein/nodes'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { creationGuideFacts } from './facts'
import { guideStorageKey, readGuidePreferences, writeGuidePreferences } from './preferences'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})
const open = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  docs.push(doc)
  return doc
}
const shot = (no = 1, extra = {}) =>
  Shot.parse({ id: `shot-${no}`, no, description: `画面 ${no}`, ...extra })
const node = (doc: PleinDoc, type: string, params: Record<string, unknown> = {}) =>
  createElement(doc, { kind: 'node', nodeType: type, params, x: 0, y: 0, w: 200, h: 100 })
const board = (doc: PleinDoc, shots = [shot()]) => node(doc, STORYBOARD_TYPE, { shots })
const step = (doc: PleinDoc, id: string, options = {}) =>
  creationGuideFacts(doc, options).steps.find((s) => s.id === id)!
let seq = 0
const media = (doc: PleinDoc, id: string, type: 'image' | 'video' | 'audio') => {
  const result = {
    id: `candidate-${++seq}`,
    runId: `run-${seq}`,
    port: type === 'image' ? 'images' : type,
    at: seq,
    value: { type, assetId: String(seq).padStart(64, 'a') } as ResultValue,
  }
  addResults(doc, id, [result], { adopt: true })
  return result
}
const generated = (
  doc: PleinDoc,
  boardId: string,
  role: 'image' | 'video' | 'speech' | 'sfx',
  shotId = 'shot-1',
  extra = {},
) => {
  const id = node(doc, `plein/${role}`, {
    source: { storyboard: boardId, shot: shotId, role, ...extra },
  })
  media(doc, id, role === 'speech' || role === 'sfx' ? 'audio' : role)
  return id
}
const approve = (doc: PleinDoc, id: string, status: 'usable' | 'changes' = 'usable') =>
  recordCreativeReview(doc, id, { target: creativeReviewTarget(doc.get(id))!, status })
const sequence = (doc: PleinDoc, video: string) => {
  const id = node(doc, SEQUENCE_TYPE)
  updateElement(doc, video, {
    ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
  })
  updateElement(doc, id, {
    ports: {
      inputs: [{ id: 'clips', label: '镜头', type: 'video', multiple: true }],
      outputs: [{ id: 'video', label: '视频', type: 'video' }],
    },
  })
  expect(connect(doc, [video, 'video'], [id, 'clips'])).toBeTruthy()
  return id
}

describe('持续创作引导的事实推导', () => {
  it('自由画布无剧本引导，不写文档或擅自建节点', () => {
    const doc = open()
    node(doc, 'plein/image', { prompt: '自由创作' })
    const before = [...doc.elements()]
    const facts = creationGuideFacts(doc)
    expect(facts.boards).toEqual([])
    expect(facts.steps).toEqual([])
    expect([...doc.elements()]).toEqual(before)
  })

  it('多份分镜必须选定，不把另一分镜的产物计入当前进度', () => {
    const doc = open(),
      a = board(doc),
      b = board(doc)
    generated(doc, a, 'image')
    generated(doc, a, 'video')
    expect(creationGuideFacts(doc).board).toBeUndefined()
    expect(creationGuideFacts(doc, { boardId: 'deleted' }).steps).toEqual([])
    expect(step(doc, 'trial', { boardId: a }).state).toBe('done')
    expect(step(doc, 'trial', { boardId: b }).state).toBe('ready')
  })

  it('已选分镜删除后即使仅剩另一份也不替用户更换，恢复后继续原选择', () => {
    const doc = open(),
      a = board(doc),
      b = board(doc)
    doc.undo.stopCapturing()
    deleteElements(doc, [b])
    expect(creationGuideFacts(doc, { boardId: b }).board).toBeUndefined()
    expect(creationGuideFacts(doc, { boardId: b }).steps).toEqual([])
    expect(creationGuideFacts(doc, { boardId: a }).board?.id).toBe(a)
    doc.undo.undo()
    expect(creationGuideFacts(doc, { boardId: b }).board?.id).toBe(b)
  })

  it('失效交付序列选择不回落到唯一剩余版本，也不显示成已确认', () => {
    const doc = open(),
      id = board(doc),
      video = generated(doc, id, 'video')
    const a = sequence(doc, video),
      b = sequence(doc, video)
    deleteElements(doc, [b])
    const facts = creationGuideFacts(doc, { sequenceId: b })
    expect(facts.sequences.map((sequence) => sequence.id)).toEqual([a])
    expect(facts.sequence).toBeUndefined()
    expect(facts.steps.find((s) => s.id === 'delivery')?.target).toBeUndefined()
    expect(facts.steps.find((s) => s.id === 'delivery')?.detail).toContain('原交付序列已移除')
    expect(creationGuideFacts(doc, { sequenceId: a }).sequence?.id).toBe(a)
  })

  it('只有接入当前分镜的文字算梗概，文字入口定位到真正输入而非其他游离文字', () => {
    const doc = open(),
      id = board(doc, [])
    createElement(doc, { kind: 'markdown', text: '其他创意', x: 0, y: 0, w: 200, h: 100 })
    expect(step(doc, 'brief').state).toBe('ready')
    const brief = createElement(doc, {
      kind: 'markdown',
      text: '两个人在车站告别',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const script = node(doc, 'plein/llm')
    updateElement(doc, script, {
      ports: {
        inputs: [{ id: 'prompt', label: '输入', type: 'text' }],
        outputs: [{ id: 'text', label: '剧本', type: 'text' }],
      },
    })
    updateElement(doc, id, {
      ports: { inputs: [{ id: 'script', label: '剧本', type: 'text' }], outputs: [] },
    })
    expect(connect(doc, [brief, 'text'], [script, 'prompt'])).toBeTruthy()
    expect(connect(doc, [script, 'text'], [id, 'script'])).toBeTruthy()
    expect(step(doc, 'brief')).toMatchObject({
      state: 'done',
      target: { kind: 'text', nodeId: brief },
    })
  })

  it('本机明确核对才完成分镜审核；计划变化重新待审', () => {
    const doc = open(),
      id = board(doc)
    expect(step(doc, 'storyboard').state).toBe('ready')
    const reviewedPlan = creationGuideFacts(doc).planSignature!
    expect(step(doc, 'storyboard', { reviewedPlan }).state).toBe('done')
    setParams(doc, id, { shots: [shot(1, { lighting: '逆光' })] })
    expect(step(doc, 'storyboard', { reviewedPlan }).state).toBe('attention')
    expect(creationGuideFacts(doc, { reviewedPlan }).next).toBe('storyboard')
  })

  it('有运行成功标记仍不等于完整产物或人工审片通过', () => {
    const doc = open(),
      id = board(doc)
    const image = node(doc, 'plein/image', {
      source: { storyboard: id, shot: 'shot-1', role: 'image' },
    })
    writeRun(doc, image, { id: 'run-success', status: 'succeeded', at: 1 })
    expect(step(doc, 'trial').state).toBe('ready')
    expect(step(doc, 'review').state).toBe('todo')
    media(doc, image, 'image')
    generated(doc, id, 'video')
    expect(step(doc, 'trial').state).toBe('done')
    expect(step(doc, 'review').state).toBe('ready')
  })

  it('试做镜头需要每句对白和约定音效，并按稳定dialogueId匹配', () => {
    const doc = open(),
      id = board(doc, [
        shot(1, {
          dialogue: [
            { id: 'a', character: '甲', line: '你好' },
            { id: 'b', character: '乙', line: '再见' },
          ],
          sfx: '关门',
        }),
      ])
    generated(doc, id, 'image')
    generated(doc, id, 'video')
    generated(doc, id, 'speech', 'shot-1', { dialogueId: 'b', line: 0 })
    expect(step(doc, 'trial').state).toBe('ready')
    generated(doc, id, 'speech', 'shot-1', { dialogueId: 'a', line: 1 })
    expect(step(doc, 'trial').state).toBe('ready')
    generated(doc, id, 'sfx')
    expect(step(doc, 'trial').state).toBe('done')
  })

  it('全部所需采用项人工可用才通过样片，换候选和输入变化都会重新待审', () => {
    const doc = open(),
      id = board(doc),
      image = generated(doc, id, 'image'),
      video = generated(doc, id, 'video')
    approve(doc, image)
    expect(step(doc, 'review').state).toBe('ready')
    approve(doc, video)
    expect(step(doc, 'review').state).toBe('done')
    expect(step(doc, 'review', { staleIds: new Set([video]) }).state).toBe('attention')
    const old = creativeReviewTarget(doc.get(video))!.resultId!
    media(doc, video, 'video')
    expect(step(doc, 'review').state).toBe('ready')
    adoptResult(doc, video, old)
    expect(step(doc, 'review').state).toBe('done')
    approve(doc, video, 'changes')
    expect(step(doc, 'review').state).toBe('attention')
  })

  it('选定试做镜头后不沿用另一镜头的人工结论，批量进度单独计算', () => {
    const doc = open(),
      id = board(doc, [shot(1), shot(2)])
    for (const role of ['image', 'video'] as const) approve(doc, generated(doc, id, role))
    expect(step(doc, 'review').state).toBe('done')
    expect(step(doc, 'review', { trialShotId: 'shot-2' }).state).toBe('todo')
    expect(step(doc, 'batch').detail).toContain('1/2')
    expect(step(doc, 'batch').state).toBe('ready')
  })

  it('显式试做镜头移除后不替换为其他已完成镜头，恢复原镜头后继续原状态', () => {
    const doc = open(),
      id = board(doc, [shot(1), shot(2)])
    for (const no of [1, 2])
      for (const role of ['image', 'video'] as const)
        approve(doc, generated(doc, id, role, `shot-${no}`))
    const options = { trialShotId: 'shot-2' }
    expect(step(doc, 'review', options).state).toBe('done')
    setParams(doc, id, { shots: [shot(1)] })
    expect(creationGuideFacts(doc, options).trialShot).toBeUndefined()
    expect(step(doc, 'trial', options)).toMatchObject({ state: 'attention', target: undefined })
    expect(step(doc, 'review', options)).toMatchObject({ state: 'attention', target: undefined })
    expect(step(doc, 'batch', options).state).toBe('done')
    setParams(doc, id, { shots: [shot(1), shot(2)] })
    expect(creationGuideFacts(doc, options).trialShot?.id).toBe('shot-2')
    expect(step(doc, 'review', options).state).toBe('done')
  })

  it('试做镜头删空时保留待检查而不指向历史产物，新增其他镜头也需明确选择', () => {
    const doc = open(),
      id = board(doc)
    generated(doc, id, 'image')
    generated(doc, id, 'video')
    setParams(doc, id, { shots: [] })
    expect(step(doc, 'trial', { trialShotId: 'shot-1' }).target).toBeUndefined()
    expect(step(doc, 'review', { trialShotId: 'shot-1' }).state).toBe('attention')
    setParams(doc, id, { shots: [shot(2)] })
    expect(creationGuideFacts(doc, { trialShotId: 'shot-1' }).trialShot).toBeUndefined()
    expect(creationGuideFacts(doc, { trialShotId: 'shot-2' }).trialShot?.id).toBe('shot-2')
  })

  for (const role of ['speech', 'sfx'] as const) {
    it(`${role} 只沿对应声音端口关联，清空后不回落到唯一历史序列`, () => {
      const doc = open(),
        id = board(doc, [
          shot(1, {
            dialogue: role === 'speech' ? [{ id: 'line', character: '甲', line: '你好' }] : [],
            sfx: role === 'sfx' ? '关门' : '',
          }),
        ])
      const audio = generated(doc, id, role, 'shot-1', { dialogueId: 'line', line: 0 })
      updateElement(doc, audio, {
        ports: { inputs: [], outputs: [{ id: 'audio', label: '声音', type: 'audio' }] },
      })
      const films = [role === 'speech' ? 'dialogue' : 'sfx', 'music'].map((port) => {
        const film = node(doc, SEQUENCE_TYPE)
        updateElement(doc, film, {
          ports: {
            inputs: [{ id: port, label: port, type: 'audio', multiple: true }],
            outputs: [],
          },
        })
        expect(connect(doc, [audio, 'audio'], [film, port])).toBeTruthy()
        return film
      })
      expect(creationGuideFacts(doc).sequences.map((film) => film.id)).toEqual([films[0]])
      deleteElements(doc, [films[1]!])
      setParams(doc, id, { shots: [shot(1)] })
      expect(creationGuideFacts(doc).sequences).toEqual([])
      expect(step(doc, 'delivery').target).toMatchObject({ kind: 'storyboard', nodeId: id })
      expect(step(doc, 'delivery', { sequenceId: films[0] }).detail).toContain(
        '原交付序列已移除或不再关联',
      )
    })
  }

  it('未展开单分镜模板可定位唯一序列，展开后只认当前镜头有效连线', () => {
    const doc = open(),
      id = board(doc),
      film = node(doc, SEQUENCE_TYPE)
    expect(creationGuideFacts(doc).sequence?.id).toBe(film)
    generated(doc, id, 'video')
    expect(creationGuideFacts(doc).sequence).toBeUndefined()
    expect(step(doc, 'delivery').target).toMatchObject({ kind: 'storyboard', nodeId: id })
  })

  it('其他分镜删除后的残留连线不触发唯一序列回退', () => {
    const doc = open(),
      current = board(doc),
      old = board(doc)
    const video = generated(doc, old, 'video')
    sequence(doc, video)
    deleteElements(doc, [old])
    expect(creationGuideFacts(doc).board?.id).toBe(current)
    expect(creationGuideFacts(doc).sequences).toEqual([])
    expect(step(doc, 'delivery').target).toMatchObject({ kind: 'storyboard', nodeId: current })
  })

  it('脱离计划的历史节点不计入；重复生成节点也不擅自挑一个', () => {
    const doc = open(),
      id = board(doc)
    generated(doc, id, 'image', 'shot-1', { detached: true })
    generated(doc, id, 'video')
    expect(step(doc, 'trial').state).toBe('ready')
    generated(doc, id, 'image')
    generated(doc, id, 'image')
    expect(step(doc, 'trial').state).toBe('attention')
    expect(step(doc, 'trial').detail).toContain('重复')
  })

  it('多个相关成片序列要显式选择，不把animatic当已交付成片', () => {
    const doc = open(),
      id = board(doc),
      video = generated(doc, id, 'video')
    const a = sequence(doc, video),
      b = sequence(doc, video)
    const animation = node(doc, 'plein/animatic', { boardId: id })
    media(doc, animation, 'video')
    expect(creationGuideFacts(doc).sequences).toHaveLength(2)
    expect(creationGuideFacts(doc).sequence).toBeUndefined()
    expect(step(doc, 'delivery').target).toBeUndefined()
    expect(creationGuideFacts(doc, { sequenceId: b }).sequence?.id).toBe(b)
    expect(step(doc, 'delivery', { sequenceId: a }).state).toBe('todo')
  })

  it('交付确认严格绑定当前film版本且未解决意见为零，旧版确认不继承', () => {
    const doc = open(),
      id = board(doc),
      video = generated(doc, id, 'video'),
      film = sequence(doc, video)
    const output = media(doc, film, 'video')
    const record: DeliveryRecord = {
      id: 'delivery',
      resultId: output.id,
      runId: output.runId,
      assetId: 'assetId' in output.value ? output.value.assetId : '',
      kind: 'film',
      version: 'v1',
      createdAt: 1,
      width: 720,
      height: 1280,
      duration: 5,
      sources: [],
      notes: [],
      confirmedAt: 2,
    }
    expect(step(doc, 'delivery').state).toBe('ready')
    updateElement(doc, film, { deliveries: [record] })
    expect(step(doc, 'delivery').state).toBe('done')
    expect(step(doc, 'delivery', { staleIds: new Set([film]) }).state).toBe('attention')
    updateElement(doc, film, {
      deliveries: [
        { ...record, notes: [{ id: 'note', time: 2, text: '声音太小', resolved: false }] },
      ],
    })
    expect(step(doc, 'delivery').state).toBe('ready')
    updateElement(doc, film, { deliveries: [record] })
    media(doc, film, 'video')
    expect(step(doc, 'delivery').state).toBe('ready')
  })
})

describe('引导本机偏好', () => {
  it('收起、选定分镜和核对签名按canvas隔离并可重新打开', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    const prefs = {
      collapsed: true,
      boardId: 'board-a',
      reviewedPlans: { 'board-a': 'exact-plan' },
    }
    writeGuidePreferences('canvas-a', prefs, storage)
    expect(readGuidePreferences('canvas-a', storage)).toEqual(prefs)
    expect(readGuidePreferences('canvas-b', storage)).toEqual({
      collapsed: false,
      reviewedPlans: {},
    })
    expect(guideStorageKey('canvas-a')).not.toBe(guideStorageKey('canvas-b'))
  })

  it('本机存储不可用或损坏不会阻断画布', () => {
    const broken = {
      getItem: () => {
        throw new Error('disabled')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    const fallback = { collapsed: false, reviewedPlans: {} }
    expect(readGuidePreferences('canvas', broken)).toEqual(fallback)
    expect(() => writeGuidePreferences('canvas', fallback, broken)).not.toThrow()
    expect(readGuidePreferences('canvas', { getItem: () => '{broken' })).toEqual(fallback)
    expect(
      readGuidePreferences('canvas', {
        getItem: () => '{"collapsed":true,"reviewedPlans":{"a":3,"b":"plan"}}',
      }),
    ).toEqual({ collapsed: true, reviewedPlans: { b: 'plan' } })
  })
})
