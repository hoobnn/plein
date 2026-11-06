import { describe, expect, it } from 'vite-plus/test'
import {
  type BriefMaterial,
  arkPromptSize,
  bindingSuffix,
  bindingText,
  briefFamily,
  briefTask,
  buildReferenceBrief,
  explainedLabels,
  promptLengthHint,
} from './reference-brief'

/** 同一组输入：同一角色的 2 张图、1 张场景图、1 段运镜视频；标签用固定字符串，措辞与编号写法分开锁 */
const sample = (labels: { image: (n: number) => string; video: (n: number) => string }) =>
  [
    {
      kind: 'image',
      index: 1,
      label: labels.image(1),
      role: { type: 'character', name: '林夏', elementId: 'c' },
    },
    {
      kind: 'image',
      index: 2,
      label: labels.image(2),
      role: { type: 'character', name: '林夏', elementId: 'c' },
    },
    {
      kind: 'image',
      index: 3,
      label: labels.image(3),
      role: { type: 'scene', name: '天台', elementId: 's' },
    },
    {
      kind: 'video',
      index: 1,
      label: labels.video(1),
      role: { type: 'effect', name: '推近', elementId: 'e' },
    },
  ] satisfies BriefMaterial[]

describe('素材说明段：各平台措辞', () => {
  it('方舟：同一角色的多张图合并成一个主体，每条写清作用', () => {
    expect(
      buildReferenceBrief({
        family: 'ark',
        materials: sample({ image: (n) => `图片${n}`, video: (n) => `视频${n}` }),
      }),
    ).toMatchInlineSnapshot(`
      "图片1、图片2：同一角色「林夏」的多张外貌参考，合并为一个主体，保持面部、发型、服装一致
      图片3：场景「天台」的环境参考，保持空间布局与光线氛围
      视频1：运镜与动作参考视频「推近」，沿用其镜头运动与节奏"
    `)
  })

  it('MiniMax：英文职责行，编号写法与英文标签不同时并列写出', () => {
    expect(
      buildReferenceBrief({
        family: 'minimax',
        materials: sample({ image: (n) => `图片${n}`, video: (n) => `视频${n}` }),
      }),
    ).toMatchInlineSnapshot(`
      "Image 1 (图片1), Image 2 (图片2): multiple views of the same character "林夏". Keep face, hairstyle and outfit consistent.
      Image 3 (图片3): scene reference "天台". Keep the layout, lighting and atmosphere.
      Video 1 (视频1): camera-movement reference video "推近". Follow its camera motion and pacing."
    `)
    // 标签本身就是英文写法时不重复
    expect(
      buildReferenceBrief({
        family: 'minimax',
        materials: sample({ image: (n) => `Image ${n}`, video: (n) => `Video ${n}` }),
      }).split('\n')[0],
    ).toBe(
      'Image 1, Image 2: multiple views of the same character "林夏". Keep face, hairstyle and outfit consistent.',
    )
  })

  it('万相：图N / 视频N 加简短作用', () => {
    expect(
      buildReferenceBrief({
        family: 'wan',
        materials: sample({ image: (n) => `图${n}`, video: (n) => `视频${n}` }),
      }),
    ).toMatchInlineSnapshot(`
      "图1、图2：角色「林夏」的形象，保持面部与服装一致
      图3：场景「天台」，保持空间布局与光线氛围
      视频1：运镜参考视频「推近」，沿用其镜头运动"
    `)
  })

  it('图片多参考：开头一句话交代每张图的对象', () => {
    expect(
      buildReferenceBrief({
        family: 'image',
        materials: sample({ image: (n) => `图${n}`, video: (n) => `视频${n}` }).filter(
          (m) => m.kind === 'image',
        ),
      }),
    ).toBe('图1、图2是同一人物「林夏」，图3是场景「天台」。')
  })

  it('没有语义的普通素材不生成说明行', () => {
    expect(
      buildReferenceBrief({
        family: 'ark',
        materials: [{ kind: 'image', index: 1, label: '图片1', role: { type: 'generic' } }],
      }),
    ).toBe('')
  })
})

describe('编辑 / 延长任务', () => {
  const video: BriefMaterial = {
    kind: 'video',
    index: 1,
    label: '视频1',
    role: { type: 'generic' },
  }
  const hero: BriefMaterial = {
    kind: 'image',
    index: 1,
    label: '图片1',
    role: { type: 'character', name: '林夏', elementId: 'c' },
  }

  it('直接称「视频1」，说明段不出现「参考」', () => {
    const edit = buildReferenceBrief({ family: 'ark', materials: [video, hero], task: 'edit' })
    expect(edit).toMatchInlineSnapshot(`
      "图片1：角色「林夏」的外貌素材，保持面部、发型、服装一致
      视频1：待编辑的视频，保留其主体内容，仅按要求修改"
    `)
    const extend = buildReferenceBrief({ family: 'ark', materials: [video], task: 'extend' })
    expect(extend).toBe('视频1：待延长的视频，从其结尾自然接续')
    expect(edit + extend).not.toContain('参考')
  })

  it('从模型选项读取任务类型，只认 edit / extend', () => {
    const params = (task: string) => ({
      model: 'volc/ark:m',
      options: { 'volc/ark:m': { omni_reference_task_type: task } },
    })
    expect(briefTask(params('edit'))).toBe('edit')
    expect(briefTask(params('extend'))).toBe('extend')
    expect(briefTask(params('auto'))).toBeUndefined()
    expect(briefTask({})).toBeUndefined()
  })
})

describe('用户正文已写明作用时不重复', () => {
  const materials = sample({ image: (n) => `图片${n}`, video: (n) => `视频${n}` })

  it('编号后紧跟定义写法的标签被跳过，其余照常生成', () => {
    expect(explainedLabels('将图片3中的天台定义为场景，图片3是背景', ['图片3', '图片1'])).toEqual(
      new Set(['图片3']),
    )
    expect(explainedLabels('图片1中的人物定义为主体1', ['图片1'])).toEqual(new Set(['图片1']))
    expect(explainedLabels('Image 1: the hero', ['Image 1'])).toEqual(new Set(['Image 1']))
    // 只是提到编号、没有交代作用：不算
    expect(explainedLabels('让图片1走向图片2', ['图片1', '图片2'])).toEqual(new Set())
    const brief = buildReferenceBrief({
      family: 'ark',
      materials,
      userText: '图片3是天台背景，视频1：推近运镜',
    })
    expect(brief).toBe(
      '图片1、图片2：同一角色「林夏」的多张外貌参考，合并为一个主体，保持面部、发型、服装一致',
    )
  })

  it('一行里只有部分标签已交代时保留其余', () => {
    expect(
      buildReferenceBrief({
        family: 'wan',
        materials: sample({ image: (n) => `图${n}`, video: (n) => `视频${n}` }),
        userText: '图2是正脸',
      }).split('\n')[0],
    ).toBe('图1：角色「林夏」的形象，保持面部与服装一致')
  })
})

describe('资产卡绑定写法', () => {
  it('方舟用「名字@编号」，多张图列出全部；万相直接称编号；MiniMax 只留名字', () => {
    expect(bindingText('ark', '林夏', ['图片1'])).toBe('林夏@图片1')
    expect(bindingText('ark', '林夏', ['@图片1', '@图片2'])).toBe('林夏@图片1、@图片2')
    expect(bindingText('wan', '林夏', ['图1'])).toBe('图1')
    expect(bindingText('minimax', '林夏', ['图片1'])).toBe('林夏')
    expect(bindingText('image', '林夏', ['图1', '图2'])).toBe('林夏（图1、图2）')
    expect(bindingText('ark', '林夏', [])).toBe('林夏')
  })

  it('原文已写同名时只补编号', () => {
    expect(bindingSuffix('ark', '林夏', ['图片1'])).toBe('@图片1')
    expect(bindingSuffix('image', '林夏', ['图1'])).toBe('（图1）')
    expect(bindingSuffix('minimax', '林夏', ['图片1'])).toBe('')
  })

  it('平台族只看厂商与能力', () => {
    expect(briefFamily('image.generate', 'volc/ark')).toBe('image')
    expect(briefFamily('video.generate', 'volc/ark-plan')).toBe('ark')
    expect(briefFamily('video.generate', 'minimax/api')).toBe('minimax')
    expect(briefFamily('video.generate', 'aliyun/bailian')).toBe('wan')
    expect(briefFamily('video.generate', 'plein/mock')).toBeUndefined()
  })
})

describe('提示词长度软提示', () => {
  it('方舟：中文 500 字、英文 1000 词', () => {
    expect(arkPromptSize('你好，world')).toEqual({ size: 4, limit: 500, unit: '字' })
    expect(arkPromptSize('a b c')).toEqual({ size: 3, limit: 1000, unit: '词' })
    expect(promptLengthHint('ark', '字'.repeat(500))).toBeUndefined()
    expect(promptLengthHint('ark', '字'.repeat(501))).toContain('501 字')
    expect(promptLengthHint('ark', 'word '.repeat(1001))).toContain('1001 词')
  })

  it('MiniMax 声明了上限时交给硬检查，没声明时 7000 字符软提示', () => {
    expect(promptLengthHint('minimax', 'a'.repeat(7001), { declaredLimit: 7000 })).toBeUndefined()
    expect(promptLengthHint('minimax', 'a'.repeat(7000))).toBeUndefined()
    expect(promptLengthHint('minimax', 'a'.repeat(7001))).toContain('7001')
    expect(promptLengthHint('wan', 'a'.repeat(9000))).toBeUndefined()
  })
})
