import type { Engine } from '@plein/canvas-core'
import { setParams } from '@plein/doc'
import { presetsFor } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { parseNodeDescriptorParams } from '@plein/plugin-sdk'
import { applyAspect, aspectKey, fieldsOf, promptKey, type NodeInfo } from '../../canvas/nodes'
import { adaptToModel, selectedModel } from '../../canvas/modelParams'

export type RecipePreset = Catalog['prompts'][number]

/** 内容说明与执行预设分开；这些示意不代表真实模型生成效果。 */
export const recipeGuides: Record<string, { inputs: string; note: string; cells: string[] }> = {
  'plein/three-view': {
    inputs: '填写角色外观；已有角色时，添加角色参考图。',
    note: '检查三个视角的人物、服装与比例是否一致。',
    cells: ['正面', '侧面', '背面'],
  },
  'plein/expression-sheet': {
    inputs: '填写角色设定；建议连入已采用的角色参考图。',
    note: '检查身份一致性及表情差异，九宫格数量不由提示词保证。',
    cells: ['开心', '愤怒', '悲伤', '惊讶', '恐惧', '厌恶', '平静', '害羞', '坚定'],
  },
  'plein/multi-angle': {
    inputs: '填写同一时刻的场景和动作；可添加人物与场景参考。',
    note: '这是提示词预设，不是精确的三维机位控制。',
    cells: ['远景', '全景', '中景', '近景', '特写', '俯拍', '仰拍', '过肩', '主观'],
  },
  'plein/continuous-storyboard': {
    inputs: '填写一段有动作推进的剧情；可添加角色参考。',
    note: '检查阅读顺序、人物身份和动作衔接，再切分为镜头。',
    cells: ['起点', '推进', '转折', '结果'],
  },
  'plein/plot-deduction': {
    inputs: '需要一张起始参考图，并填写剧情方向。',
    note: '套用不会自动添加参考图；请在实际输入中确认参考已送入。',
    cells: ['参考图', '瞬间二', '瞬间三', '瞬间四'],
  },
  'plein/slow-push': {
    inputs: '填写主体；图生视频时另行添加首帧并选择相应模式。',
    note: '镜头运动与细微动作仍需生成后审片。',
    cells: ['全貌', '接近', '细节'],
  },
  'plein/orbit': {
    inputs: '填写主体；可添加参考首帧，确认所选模型支持的模式。',
    note: '环绕过程中可能出现主体变形，提示词不保证几何一致。',
    cells: ['起始视角', '侧向', '结束视角'],
  },
  'plein/script': {
    inputs: '填写剧情梗概；生成后的文本可连接分镜节点。',
    note: '先检查剧情、人物与对白，再建立分镜和批量生成。',
    cells: ['梗概', '分场剧本', '分镜'],
  },
}

export function recipeSignature(params: Record<string, unknown> | undefined): string {
  return JSON.stringify(params ?? {})
}

/** 显式采用时校验弹窗打开以来的草稿和预设；一次事务，只改已声明的非模型参数。 */
export function applyRecipe(
  engine: Engine,
  catalog: Catalog,
  id: string,
  preset: RecipePreset,
  expected: { params: string; type: string; version: number },
): string | null {
  const el = engine.doc.get(id)
  if (engine.doc.readOnly) return '当前画布只读，未套用配方'
  if (
    !el ||
    el.nodeType !== expected.type ||
    (el.nodeVersion ?? 1) !== expected.version ||
    recipeSignature(el.params) !== expected.params
  )
    return '节点或草稿已变化，未覆盖当前内容；请关闭后重新打开配方'
  const node = catalog.nodes.find((n) => n.type === el.nodeType && n.version === expected.version)
  const current = catalog.prompts.find((p) => p.id === preset.id)
  if (!node || !current || JSON.stringify(current) !== JSON.stringify(preset))
    return '配方或插件目录已变化，请关闭后重新打开配方'
  if (!presetsFor([current], node).length) return '配方不适用于当前节点'
  const pk = promptKey(node)
  if (!pk) return '当前节点没有可套用的提示词字段'
  const patch: Record<string, unknown> = { [pk]: preset.template }
  for (const [key, field] of fieldsOf(node)) {
    if (
      key === 'model' ||
      field.widget === 'model' ||
      field.widget === 'modelOptions' ||
      key === pk
    )
      continue
    if (Object.hasOwn(preset.params ?? {}, key)) patch[key] = preset.params![key]
  }
  try {
    const next = { ...el.params, ...patch }
    parseNodeDescriptorParams(node, next)
    const adjusted = adaptToModel(node, next, selectedModel(catalog, node, next)?.info).patch
    const incompatible = Object.keys(patch).filter((key) => Object.hasOwn(adjusted, key))
    if (incompatible.length)
      return '配方参数不适用于当前模型，未改写草稿；请选择其他配方或先调整模型'
  } catch (error) {
    return `配方参数无效，未改写草稿：${(error as Error).message}`
  }
  engine.doc.undo.stopCapturing()
  engine.doc.ydoc.transact(() => {
    setParams(engine.doc, id, patch)
    const ak = aspectKey(node)
    if (ak && patch[ak] !== undefined) applyAspect(engine, id, patch[ak])
  }, engine.doc.origin)
  engine.doc.undo.stopCapturing()
  return null
}

export function searchRecipes(
  presets: RecipePreset[],
  node: NodeInfo,
  query: string,
  plugins: Catalog['plugins'] = [],
) {
  const q = query.trim().toLowerCase()
  return presetsFor(presets, node).filter((p) =>
    [
      p.title,
      p.description,
      p.id,
      p.plugin,
      plugins.find((item) => item.id === p.plugin)?.name,
      recipeGuides[p.id]?.inputs,
    ]
      .join(' ')
      .toLowerCase()
      .includes(q),
  )
}
