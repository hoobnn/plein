/**
 * 短剧预制模板：纯数据定义与纯函数（不碰 yjs、不碰 catalog 具体类型）。
 * 落画布由宿主完成（前端 apps/web/src/canvas/drama.ts），因此这里只回答
 * 「铺哪些元素、连哪些线、每个卡片的默认参数是什么」。
 *
 * 两条约定：
 * - 模型 id 一律不写死。模板只声明这个节点要哪个能力（capability），
 *   具体模型由宿主按已启用的平台挑；挑不到时留空并提示去设置里启用。
 * - 铺模板只建结构与连线，绝不触发任何节点运行，插入本身不花钱。
 */

/** 模板里的一个元素：分组（frame）、节点，或 Markdown 素材 */
export interface DramaElementSpec {
  /** 模板内引用用的 key，连线按它连 */
  key: string
  /** frame 是分组；element 是节点（type 为节点类型）或 'markdown' */
  shape: 'frame' | 'element'
  /** 分组忽略；元素为节点类型或 'markdown' */
  type: string
  title: string
  /** 父分组的 key；不填为顶层 */
  parent?: string
  /** 相对父分组左上角的坐标；顶层为世界坐标 */
  x: number
  y: number
  w: number
  h: number
  /** 节点参数。提示词一律是可改的默认值，不在执行器里硬编码 */
  params?: Record<string, unknown>
  /** Markdown 素材的正文 */
  text?: string
  /** 这个节点要调模型的能力；有值时由宿主填 model 参数 */
  capability?: string
  /** catalog 里还没有这个节点类型时跳过并提示，不算错误（道具 / 风格卡） */
  optional?: boolean
}

export interface DramaEdgeSpec {
  from: [string, string]
  to: [string, string]
}

export interface DramaTemplateSpec {
  id: string
  title: string
  description: string
  elements: DramaElementSpec[]
  edges: DramaEdgeSpec[]
}

/** 默认 8 个镜头，roadmap 要求整条链路在 6–10 镜头内跑通 */
export const DEFAULT_SHOT_COUNT = 8
export const MIN_SHOTS = 6
export const MAX_SHOTS = 10

export interface DramaTemplateOptions {
  /** 分镜镜头数，同时写进分镜节点参数与提示词 */
  shotCount?: number
}

/** 内置中文提示词：剧本、角色场景抽取、分镜三处都是可改的默认值 */
const SCRIPT_SYSTEM =
  '你是一名竖屏短剧编剧，擅长把梗概写成分场剧本：台词口语化，人物动机清晰，每场都有推进。'
const SCRIPT_PROMPT = `把下面的创意改写成竖屏短剧剧本：
- 按场次分段，每场写明时间、地点、出场人物
- 对白口语化，一句不超过 20 字
- 开头三秒出现冲突，结尾留钩子
- 总时长 60–90 秒，能拍成一串短镜头

创意：`

const CAST_SYSTEM =
  '你是一名短剧美术指导，擅长从剧本里抽出可以拿去生成设定图的角色、场景与道具描述。'
const CAST_PROMPT = `读下面的剧本，抽出角色、场景和关键道具设定，只输出下面这种 Markdown，不要解释：

## 角色
### 角色名
- 外貌与年龄：
- 服装：
- 性格：
- 性别：（男 / 女，配音按它挑音色）
- 辨识特征：（出图时用它保持同一个人）

## 场景
### 场景名
- 时间与地点：
- 光线与氛围：

## 道具
### 道具名
- 外观：（材质、颜色、尺寸、做旧程度）
- 剧情作用：
（只列在多个镜头里出现、推动剧情的关键物件；没有就省略这一节）

剧本：`

const IDEA_TEXT = `# 创意 / 梗概

一句话故事：快递员在雨夜天台捡到一个上锁的铁盒，从此被卷进一桩旧案。

- 类型：都市悬疑
- 画幅：竖屏 9:16
- 节奏：60–90 秒，开场三秒有冲突，结尾留钩子
- 主角：林晚，二十岁，短发，倔强
- 场景：雨夜，老城区天台，霓虹反光

（把这段换成你自己的创意，下面的剧本、角色场景、分镜会跟着重跑。）`

/** 媒体卡片按竖屏排版；画幅也写进参数，生成结果直接能用 */
const VERTICAL = '9:16'

const card = (
  key: string,
  type: string,
  title: string,
  x: number,
  y: number,
  w = 280,
  h = 240,
  extra: Partial<DramaElementSpec> = {},
): DramaElementSpec => ({ key, shape: 'element', type, title, x, y, w, h, ...extra })

const frame = (
  key: string,
  title: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parent?: string,
): DramaElementSpec => ({ key, shape: 'frame', type: 'frame', title, x, y, w, h, parent })

/**
 * 短剧模板：创意 / 梗概 → 剧本 → 角色与场景 → 分镜 →（展开）镜头图 → 镜头视频 → 配音 → 序列。
 * 分镜到镜头的展开入口是分镜节点本身（双击打开分镜表 → 展开），
 * 模板只负责把它放到位并带好镜头数，不代替展开逻辑。
 */
export function dramaTemplate(opts: DramaTemplateOptions = {}): DramaTemplateSpec {
  const shotCount = Math.min(
    MAX_SHOTS,
    Math.max(MIN_SHOTS, Math.round(opts.shotCount ?? DEFAULT_SHOT_COUNT)),
  )
  const SKELETON_H = 1060
  return {
    id: 'builtin/drama',
    title: '短剧模板',
    description: '创意 → 剧本 → 角色与场景 → 分镜 → 镜头图 → 镜头视频 → 配音配乐 → 序列',
    elements: [
      // ── 骨架：把创意一路推到分镜表 ──
      frame('skeleton', '短剧 · 创意与骨架', 0, 0, 1500, SKELETON_H),
      card('idea', 'markdown', '创意 / 梗概', 40, 40, 320, 280, {
        parent: 'skeleton',
        text: IDEA_TEXT,
      }),
      card('script', 'plein/llm', '剧本', 420, 40, 280, 240, {
        parent: 'skeleton',
        capability: 'text.chat',
        params: { system: SCRIPT_SYSTEM, prompt: SCRIPT_PROMPT },
      }),
      card('cast', 'plein/llm', '角色与场景抽取', 800, 40, 280, 240, {
        parent: 'skeleton',
        capability: 'text.chat',
        params: { system: CAST_SYSTEM, prompt: CAST_PROMPT },
      }),
      card('prop', 'plein/prop', '道具', 1180, 40, 280, 240, {
        parent: 'skeleton',
        optional: true,
      }),
      card('shots', 'plein/storyboard', `分镜（双击展开镜头）`, 420, 400, 320, 280, {
        parent: 'skeleton',
        capability: 'text.chat',
        params: {
          prompt: `按竖屏短剧拆成 ${shotCount} 个镜头，每个镜头 3–5 秒；写清景别、画面描述、出场角色、情绪、光线、台词，并给出镜头图提示词与运镜提示词。`,
          shotCount,
        },
      }),
      card('character', 'plein/character', '主角', 800, 400, 280, 240, {
        parent: 'skeleton',
        params: { description: '二十岁，短发，白衬衫，倔强眼神；辨识特征：左眉有一道疤' },
      }),
      card('scene', 'plein/scene', '场景', 1180, 400, 280, 240, {
        parent: 'skeleton',
        params: { description: '雨夜，老城区天台，霓虹反光，湿漉漉的水泥地面' },
      }),
      card('style', 'plein/style', '画风', 1180, 700, 280, 240, {
        parent: 'skeleton',
        optional: true,
      }),
      card('charimg', 'plein/image', '角色定妆图', 800, 700, 180, 320, {
        parent: 'skeleton',
        capability: 'image.generate',
        params: {
          prompt:
            '【角色名】的定妆参考图：正面、侧面、背面三视图，全身站姿，同一角色同一服装，纯白背景，平光，角色设计稿风格，线条清晰',
          aspectRatio: VERTICAL,
          count: 2,
        },
      }),

      // ── 镜头与成片：一条样例车道，说明每个镜头展开后长什么样 ──
      frame('stage', '短剧 · 镜头与成片', 0, SKELETON_H + 80, 960, 700),
      frame('lane', '镜头 01 · 样例（展开后每个镜头都是这个结构）', 40, 40, 520, 620, 'stage'),
      card('shotImage', 'plein/image', '分镜图', 40, 40, 180, 320, {
        parent: 'lane',
        capability: 'image.generate',
        params: {
          prompt:
            '【场景】·【景别】·【画面描述】，电影感光影，人物与服装和角色卡保持一致，竖屏构图',
          aspectRatio: VERTICAL,
          count: 2,
        },
      }),
      card('shotVideo', 'plein/video', '镜头视频', 300, 40, 180, 320, {
        parent: 'lane',
        capability: 'video.generate',
        params: {
          prompt: '【运镜方式】，人物有细微动作和呼吸感，背景景深轻微变化，画面稳定，不切镜',
          mode: 'image',
          aspectRatio: VERTICAL,
          duration: 5,
        },
      }),
      card('shotSpeech', 'plein/speech', '对白配音', 40, 420, 280, 160, {
        parent: 'lane',
        capability: 'audio.speech',
        params: { text: '（示例台词）你到底把东西藏到哪儿去了？' },
      }),
      card('music', 'plein/music', '配乐', 620, 40, 280, 160, {
        parent: 'stage',
        capability: 'audio.music',
        params: {
          prompt: '都市悬疑的紧张弦乐，中速，随着冲突渐强，结尾留一个悬念，不带人声',
          duration: 30,
        },
      }),
      card('seq', 'plein/sequence', '序列', 620, 240, 260, 420, {
        parent: 'stage',
        params: { aspectRatio: VERTICAL },
      }),
    ],
    edges: [
      { from: ['idea', 'text'], to: ['script', 'prompt'] },
      { from: ['script', 'text'], to: ['cast', 'prompt'] },
      { from: ['script', 'text'], to: ['shots', 'script'] },
      // 设定清单也交给分镜：镜头里的角色、场景、道具按设定卡的名字写，展开时才 @ 得到卡片
      { from: ['cast', 'text'], to: ['shots', 'script'] },
      // 定妆图 → 角色卡的参考图：镜头图 @ 角色名时带上它（生成设定卡时每张新卡也这样配一个）
      { from: ['charimg', 'images'], to: ['character', 'references'] },
      // 图生视频：分镜图作视频的首帧，样例车道和展开出来的镜头一致
      { from: ['shotImage', 'images'], to: ['shotVideo', 'images'] },
      // 样例车道不接序列：展开分镜时真实镜头会按顺序自动接进来，样例接着反而会混进成片
      { from: ['music', 'audio'], to: ['seq', 'music'] },
    ],
  }
}

/** 模板用到的全部能力（去重），宿主按它挑模型、给提示 */
export function dramaCapabilities(t: DramaTemplateSpec): string[] {
  return [...new Set(t.elements.map((e) => e.capability).filter((c): c is string => !!c))]
}

const CAPABILITY_LABELS: Record<string, string> = {
  'text.chat': '文本',
  'image.generate': '图像',
  'video.generate': '视频',
  'audio.speech': '配音',
  'audio.music': '配乐',
  'audio.sfx': '音效',
  'audio.transcribe': '语音识别',
}

/** 能力的中文名，用于「请到设置里启用」的提示 */
export const capabilityLabel = (capability: string) => CAPABILITY_LABELS[capability] ?? capability
