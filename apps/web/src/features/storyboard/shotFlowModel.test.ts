import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { expect, it } from 'vite-plus/test'
import { composeShotPrompts } from './shotFlowModel'

it('本地提示词绑定精确资产，拼入画面、运镜、对白、音效与风格', () => {
  const doc = openDoc()
  const hero = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '林夏',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const prompt = composeShotPrompts(
    doc,
    Shot.parse({
      id: 'one',
      no: 1,
      description: '拿起杯子',
      characters: ['林夏', '未绑定道具'],
      assetBindings: { 林夏: { elementId: hero } },
      cameraMotion: '推近主体',
      dialogue: [{ character: '林夏', line: '我们走吧' }],
      sfx: '雨声',
      imagePrompt: '旧图',
      motionPrompt: '旧运动',
    }),
    ' 胶片夜景 ',
  )
  expect(prompt.imagePrompt).toContain('拿起杯子')
  expect(prompt.imagePrompt).toContain('林夏')
  expect(prompt.imagePrompt).toContain('视觉风格：胶片夜景')
  expect(prompt.motionPrompt).toContain('推近主体')
  expect(prompt.motionPrompt).toContain('未绑定道具')
  expect(prompt.motionPrompt).toContain('对白与旁白：\n林夏：我们走吧')
  expect(prompt.motionPrompt).toContain('音效：雨声')
  expect(prompt.imagePrompt).not.toContain('旧图')
  expect(prompt.motionPrompt).not.toContain('旧运动')
})
