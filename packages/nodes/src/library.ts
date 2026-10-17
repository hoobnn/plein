/**
 * 资产库的分类约定（前后端共用，纯数据）：每类资产对应哪种卡片节点、有哪些图片槽位和筛选标签，
 * 以及内置的官方风格 / 特效。
 *
 * Plein 不训练、不挂 LoRA，官方条目只是可编辑的风格提示词，
 * 用到画布上是一张风格卡，再连参考图才有更强的约束。特效同理：只有运镜 / 特效描述，不保证模型照做。
 */

export type LibraryKindId = 'character' | 'scene' | 'prop' | 'style' | 'effect'

export interface LibrarySlot {
  id: string
  label: string
  /** 一个槽位放几张；多张的按顺序排 */
  multiple?: boolean
  hint?: string
}

export interface LibraryTag {
  id: string
  label: string
  options: string[]
}

export interface LibraryKindSpec {
  id: LibraryKindId
  title: string
  /** 用到画布上展开成哪种卡片 */
  nodeType: string
  description: string
  /** 描述栏的标题与占位 */
  descriptionLabel: string
  placeholder: string
  slots: LibrarySlot[]
  tags: LibraryTag[]
  /** 有没有音色（只有角色） */
  voice?: boolean
  /** 有没有参考视频与适配模型（特效） */
  video?: boolean
}

const ERA = ['现代', '古风', '民国', '仙侠', '科幻', '奇幻']

/** 角色基础形象的四种图片；全身图继续作为生成时的第一参考。 */
export const CHARACTER_IMAGE_SLOTS = [
  {
    id: 'full_body',
    label: '全身定妆图',
    hint: '白底或干净背景的正面全身照，固定体型与服装，作为第一参考',
  },
  { id: 'portrait', label: '肖像／半身图', hint: '清晰展示脸部、发型与上半身，固定人物身份' },
  { id: 'character_3view', label: '角色设定图', hint: '正面、侧面与背面，固定多角度造型细节' },
  { id: 'face_grid', label: '情绪九宫格', hint: '同一人物的多种表情，作为情绪与表演参考' },
] as const satisfies readonly LibrarySlot[]

const CHARACTER_SLOT_ALIASES = new Map([
  ['main', 'full_body'],
  ['half', 'portrait'],
  ['emotions', 'face_grid'],
  ['sheet', 'character_3view'],
])
const CHARACTER_SLOT_IDS = new Set<string>(CHARACTER_IMAGE_SLOTS.map((slot) => slot.id))

export const LIBRARY_KINDS: readonly LibraryKindSpec[] = [
  {
    id: 'character',
    title: '角色',
    nodeType: 'plein/character',
    description:
      '角色造型：全身定妆图、肖像／半身图、情绪九宫格、角色设定图与音色，跨画布保持同一个人',
    descriptionLabel: '设定',
    placeholder: '外貌、发型、服装、性格，如：二十岁，黑长直，浅蓝卫衣配白色阔腿裤，爱笑',
    slots: [...CHARACTER_IMAGE_SLOTS, { id: 'extra', label: '其他参考', multiple: true }],
    tags: [
      { id: 'gender', label: '性别', options: ['女', '男', '其他'] },
      { id: 'age', label: '年龄段', options: ['儿童', '少年', '青年', '中年', '老年'] },
      {
        id: 'region',
        label: '文化区域',
        options: ['东亚', '欧美', '南亚', '中东', '非洲', '奇幻'],
      },
      { id: 'era', label: '年代', options: ERA },
    ],
    voice: true,
  },
  {
    id: 'scene',
    title: '场景',
    nodeType: 'plein/scene',
    description: '场景设定：主场景图、多角度与全景，固化地点、光线和氛围',
    descriptionLabel: '设定',
    placeholder: '时间、地点、光线、氛围、陈设，如：雨夜，老城区天台，霓虹反光，晾衣绳',
    slots: [
      { id: 'main', label: '主场景图' },
      { id: 'angle', label: '多角度', multiple: true, hint: '同一场景的不同机位' },
      { id: 'panorama', label: '全景' },
      { id: 'extra', label: '其他参考', multiple: true },
    ],
    tags: [
      { id: 'space', label: '空间', options: ['室内', '室外'] },
      { id: 'time', label: '时段', options: ['白天', '黄昏', '夜晚', '清晨'] },
      { id: 'era', label: '年代', options: ERA },
    ],
  },
  {
    id: 'prop',
    title: '道具',
    nodeType: 'plein/prop',
    description: '道具设定：跨镜头复用的关键物件，外观一次定死',
    descriptionLabel: '设定',
    placeholder: '材质、颜色、做旧程度，如：磨砂黑的旧打火机，铜盖有划痕',
    slots: [
      { id: 'main', label: '主图' },
      { id: 'angle', label: '多角度', multiple: true },
    ],
    tags: [{ id: 'era', label: '年代', options: ERA }],
  },
  {
    id: 'style',
    title: '风格',
    nodeType: 'plein/style',
    description: '风格库：画面风格提示词 + 参考图，整部片统一画风',
    descriptionLabel: '风格提示词',
    placeholder: '影调、质感、年代、镜头，如：90 年代港片，胶片颗粒，冷调霓虹，浅景深',
    slots: [{ id: 'ref', label: '参考图', multiple: true }],
    tags: [
      {
        id: 'category',
        label: '类别',
        options: ['摄影写实', '电影质感', '动漫', '插画', '国风', '3D', '复古'],
      },
    ],
  },
  {
    id: 'effect',
    title: '特效',
    nodeType: 'plein/effect',
    description: '特效库：运镜、转场与视觉特效的描述和参考视频，在视频提示词里 @ 引用',
    descriptionLabel: '运镜 / 特效描述',
    placeholder: '镜头怎么动、画面怎么变，如：镜头从高空俯冲穿过云层，贴近地面后急停',
    slots: [{ id: 'cover', label: '封面' }],
    tags: [{ id: 'category', label: '类别', options: ['运镜', '转场', '特效', '氛围'] }],
    video: true,
  },
]

export const libraryKind = (id: string) => LIBRARY_KINDS.find((k) => k.id === id)

/** 卡片节点类型 → 资产类别（画布上的卡片存入资产库时用） */
export const libraryKindOfNode = (nodeType: string | undefined) =>
  LIBRARY_KINDS.find((k) => k.nodeType === nodeType)

/** 内置的官方条目：只有提示词，没有图片，用到画布上可以再连参考图 */
export interface OfficialLibraryItem {
  id: string
  kind: 'style' | 'effect'
  name: string
  description: string
  tags: Record<string, string>
  models?: string[]
}

const style = (id: string, name: string, category: string, description: string) =>
  ({ id: `official/style/${id}`, kind: 'style', name, tags: { category }, description }) as const

const effect = (id: string, name: string, category: string, description: string) =>
  ({ id: `official/effect/${id}`, kind: 'effect', name, tags: { category }, description }) as const

export const OFFICIAL_LIBRARY: readonly OfficialLibraryItem[] = [
  style(
    'hk-film',
    '90 年代港片',
    '电影质感',
    '90 年代香港电影质感，胶片颗粒，冷调霓虹与暖色街灯对比，浅景深，轻微光晕，画面略带湿润反光',
  ),
  style(
    'cinematic',
    '电影写实',
    '电影质感',
    '电影级写实摄影，35mm 胶片质感，自然光与柔和轮廓光，2.39:1 宽银幕构图，低饱和、高动态范围，细腻皮肤质感',
  ),
  style(
    'photo-portrait',
    '写实人像',
    '摄影写实',
    '商业人像摄影，85mm 定焦，柔光箱主光，干净背景，真实皮肤纹理，色彩自然，细节锐利',
  ),
  style(
    'japanese-fresh',
    '日系清新',
    '摄影写实',
    '日系清新胶片风，高调曝光，低对比，青绿偏色，柔和逆光，空气感，画面通透干净',
  ),
  style(
    'anime-2d',
    '现代都市 2D 动漫',
    '动漫',
    '现代都市日式 2D 动画风格，干净线稿，赛璐璐上色，明快配色，背景精致写实，光影层次清楚',
  ),
  style(
    'ghibli',
    '吉卜力手绘',
    '动漫',
    '宫崎骏吉卜力手绘动画风格，水彩背景，柔和自然光，温暖色调，人物比例圆润，田园与天空细节丰富',
  ),
  style(
    'guoman-cg',
    '国漫 CG',
    '动漫',
    '国产 3D 动画 CG 风格，精致建模，东方面孔，衣料与发丝细节丰富，体积光，史诗感构图',
  ),
  style(
    'ink-wash',
    '水墨古风',
    '国风',
    '中国水墨画风格，宣纸质感，留白构图，墨色浓淡晕染，点缀朱砂红，意境悠远',
  ),
  style(
    'xianxia',
    '东方玄幻',
    '国风',
    '东方玄幻仙侠世界，云海仙山，飘逸古装，流光法术特效，金色与青色主调，宏大场景',
  ),
  style(
    'pixar-3d',
    '3D 卡通',
    '3D',
    '皮克斯式 3D 卡通渲染，圆润造型，柔和全局光照，次表面散射皮肤，饱和明亮的配色',
  ),
  style(
    'clay',
    '黏土定格',
    '3D',
    '黏土定格动画风格，手工捏塑质感，可见指纹与细小瑕疵，微缩场景，暖色柔光',
  ),
  style(
    'cyberpunk',
    '赛博朋克',
    '电影质感',
    '赛博朋克夜景，高楼与全息广告，品红与青色霓虹，雨夜湿地反光，烟雾与体积光',
  ),
  style(
    'retro-vhs',
    '复古录像带',
    '复古',
    '80 年代 VHS 录像带质感，扫描线，色彩溢出，轻微抖动与噪点，暖黄偏色，画面边缘失真',
  ),
  style(
    'watercolor',
    '水彩插画',
    '插画',
    '水彩插画风格，纸张纹理，颜色自然晕开，边缘留白，清新柔和的色调',
  ),
  style(
    'gothic',
    '暗黑哥特',
    '插画',
    '暗黑哥特插画风格，高对比明暗，深红与黑色主调，繁复装饰纹样，神秘压抑的氛围',
  ),
  effect(
    'drone-dive',
    '高空俯冲',
    '运镜',
    '无人机从高空快速俯冲而下，穿过云层贴近地面，接近主体时急停并缓慢环绕',
  ),
  effect(
    'through-cloud',
    '穿云而入',
    '运镜',
    '镜头从云层上方向下推进，穿过厚厚的云层，云散后露出下方的城市或场景全貌',
  ),
  effect(
    'bee-fpv',
    '穿梭运镜',
    '运镜',
    'FPV 穿越机视角，贴着地面和物体快速穿梭，灵活转向，穿过门窗与缝隙，速度感强',
  ),
  effect(
    'eye-push',
    '瞳孔推镜',
    '运镜',
    '从人物面部特写开始持续推进，推入瞳孔，穿过瞳孔后转场进入另一个场景',
  ),
  effect(
    'earth-zoom',
    '地球缩放',
    '运镜',
    '从地面人物开始极速拉远，越过城市、大陆，直到看见整个地球；或反向从太空一路推进到人物',
  ),
  effect(
    'orbit',
    '环绕运镜',
    '运镜',
    '镜头围绕主体匀速环绕 180 度，主体始终居中，背景产生视差流动',
  ),
  effect(
    'dolly-zoom',
    '希区柯克变焦',
    '运镜',
    '镜头后退的同时变焦推近，主体大小不变而背景透视急剧拉伸，制造眩晕和不安',
  ),
  effect(
    'bullet-time',
    '子弹时间',
    '特效',
    '时间几乎静止，镜头绕着定格的主体快速环绕，空中的水滴、碎片悬停可见',
  ),
  effect(
    'slow-explosion',
    '升格爆炸',
    '特效',
    '高速摄影升格慢镜头，爆炸火球缓慢膨胀，碎片与火星向四周飞散，冲击波推开烟尘',
  ),
  effect(
    'product-sweep',
    '产品扫光',
    '特效',
    '黑色背景中一道高光缓慢扫过产品表面，勾勒出轮廓和材质细节，镜头微微推近',
  ),
  effect(
    'underwater-slow',
    '水下慢镜头',
    '特效',
    '物体落入水中的慢镜头，激起气泡与水花，光线在水中折射出焦散纹理',
  ),
  effect(
    'mirror-clone',
    '镜面分身',
    '特效',
    '主体在镜面中分裂出多个分身，分身动作略有延迟，镜头缓慢移动展示层层反射',
  ),
  effect(
    'burning-open',
    '燃烧开场',
    '转场',
    '画面从边缘开始燃烧卷曲，烧穿后露出下一个场景，火星与灰烬飘落',
  ),
  effect(
    'whip-pan',
    '甩镜转场',
    '转场',
    '镜头快速横甩产生强烈动态模糊，模糊中切换到下一个场景并稳定下来',
  ),
  effect(
    'match-cut',
    '匹配转场',
    '转场',
    '用相似的形状或动作衔接两个场景，前一镜头的圆形物体无缝变成下一镜头的另一个圆形物体',
  ),
  effect(
    'neon-rain',
    '霓虹雨夜',
    '氛围',
    '夜晚细雨，霓虹灯在湿润地面上拉出长长的倒影，雨丝在灯光中清晰可见',
  ),
  effect(
    'golden-hour',
    '黄金时刻',
    '氛围',
    '日落前的暖金色逆光，空气中漂浮尘埃，长长的影子，人物轮廓镶着金边',
  ),
]

/**
 * 旧角色槽位兼容到四种基础图片。单张槽位多出来的图片放入其他参考，未知槽位原样保留。
 * 不按 assetId 去重：同一张图可以承担不同用途，历史图片也不能在迁移时被吞掉。
 */
export function normalizeLibraryImages<T extends { slot: string }>(
  kind: LibraryKindSpec | string,
  images: readonly T[],
): T[] {
  if ((typeof kind === 'string' ? kind : kind.id) !== 'character') return [...images]
  const used = new Set<string>()
  return images.map((image) => {
    let slot = CHARACTER_SLOT_ALIASES.get(image.slot) ?? image.slot
    if (CHARACTER_SLOT_IDS.has(slot)) {
      if (used.has(slot)) slot = 'extra'
      else used.add(slot)
    }
    return slot === image.slot ? image : { ...image, slot }
  })
}

/**
 * 从画布存回已关联的条目时，保留当前仍被引用图片的全部原槽位。
 * 同一素材可同时用于肖像和全身图，不能用 assetId → 单个槽位的 Map 覆盖其中一种用途。
 */
export function preserveLibraryImageSlots<T extends { slot: string; assetId: string }>(
  kind: LibraryKindSpec | string,
  current: readonly T[],
  previous: readonly T[],
): T[] {
  const slots = new Map<string, T[]>()
  for (const image of previous) {
    const list = slots.get(image.assetId) ?? []
    list.push(image)
    slots.set(image.assetId, list)
  }
  const seen = new Set<string>()
  const images = current.flatMap((image) => {
    if (seen.has(image.assetId)) return []
    seen.add(image.assetId)
    return slots.get(image.assetId) ?? [image]
  })
  return normalizeLibraryImages(kind, images)
}

/** 卡片上用的参考图顺序：兼容旧角色槽位，按槽位定义的顺序排，未知槽位放最后 */
export function orderedImages<T extends { slot: string }>(
  kind: LibraryKindSpec,
  images: readonly T[],
) {
  const rank = new Map(kind.slots.map((s, i) => [s.id, i]))
  return normalizeLibraryImages(kind, images).sort(
    (a, b) => (rank.get(a.slot) ?? kind.slots.length) - (rank.get(b.slot) ?? kind.slots.length),
  )
}

/** 用到画布上的图片素材：保持槽位顺序，同一张图承担多种用途时只连入一次。 */
export function libraryReferenceImageIds(
  kind: LibraryKindSpec,
  images: readonly { slot: string; assetId: string }[],
): string[] {
  return [...new Set(orderedImages(kind, images).map((image) => image.assetId))]
}

/**
 * 画布卡片连入的参考图分到槽位：第一张放第一个槽位，其余放最后一个可多张的槽位
 * （角色：全身定妆图 + 其他参考）。用户可以在资产库里再调。
 */
export function slotImages(kind: LibraryKindSpec, assetIds: readonly string[]) {
  const first = kind.slots[0]!
  const rest = [...kind.slots].reverse().find((s) => s.multiple) ?? first
  const seen = new Set<string>()
  const out: Array<{ slot: string; assetId: string }> = []
  for (const id of assetIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ slot: out.length === 0 ? first.id : rest.id, assetId: id })
  }
  // 只有一个单张槽位（如特效封面）时多出来的图丢掉，不塞进同一个单张槽位
  return rest.multiple ? out : out.slice(0, 1)
}
