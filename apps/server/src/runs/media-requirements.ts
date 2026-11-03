import type { PleinDoc } from '@plein/doc'
import {
  type Capability,
  mediaBatchProblems,
  mediaRequirementOf,
  type MediaSample,
  type ModelSpec,
  type PortValue,
  videoTaskOverrides,
} from '@plein/plugin-sdk'
import { corePlugin } from '@plein/nodes'
import type { InputRef } from '@plein/protocol'

import type { PluginHost } from '../plugins/host'

/**
 * 运行前检查实际送入模型的素材（参考图 / 参考视频 / 参考音频 / 精修原图）：
 * 格式、大小、尺寸、时长直接读资产记录；编码、帧率、音轨要探测，探测不到就不阻断，
 * 留给运行期按同一份声明再挡一次。
 */

/** 探测结果的缓存上限：资产内容不可变，同一个 id 的探测结果不会变 */
const PROBE_CACHE_LIMIT = 512

/** 按资产 id 缓存探测结果 */
const probeCache = new Map<string, Promise<MediaSample | undefined>>()

/** 清空探测缓存（测试用） */
export function clearMediaProbeCache() {
  probeCache.clear()
}

/** 探测一个视频资产的编码信息；探测失败不阻断，交给运行期 */
async function probeMedia(
  host: PluginHost,
  ownerId: string,
  assetId: string,
  signal: AbortSignal,
): Promise<MediaSample | undefined> {
  const cached = probeCache.get(assetId)
  if (cached) return cached
  const pending = (async () => {
    try {
      const services = host.services(corePlugin.manifest, { ownerId, signal })
      const info = await services.media.probe({ kind: 'video', assetId })
      const details = info as {
        videoCodec?: string
        frameRate?: number
        audioCodecs?: string[]
      }
      return {
        ...(details.videoCodec ? { videoCodec: details.videoCodec } : {}),
        ...(typeof details.frameRate === 'number' ? { frameRate: details.frameRate } : {}),
        ...(Array.isArray(details.audioCodecs) ? { audioCodecs: details.audioCodecs } : {}),
      }
    } catch {
      // 探测不了就不知道编码、帧率与音轨：不在这里下结论，交给运行期
      return undefined
    }
  })()
  probeCache.set(assetId, pending)
  if (probeCache.size > PROBE_CACHE_LIMIT) {
    const oldest = probeCache.keys().next().value
    if (oldest) probeCache.delete(oldest)
  }
  return pending
}

/** 一条实际送入模型的素材 */
interface Material {
  assetId: string
  kind: 'image' | 'video' | 'audio'
}

export interface MediaRequirementsInput {
  host: PluginHost
  ownerId: string
  doc: PleinDoc
  capability: Capability
  /** 选中的模型；模型没有声明素材要求时不检查 */
  model?: ModelSpec
  /** 节点最终参数 */
  params: Record<string, unknown>
  /** 节点最终送入的输入 */
  inputs: Record<string, PortValue[]>
  /** @ 引用的明细，用来给素材找到画布上的名字 */
  details?: InputRef[]
  signal: AbortSignal
}

/** 送入模型前，从端口值里取出素材 */
const materialsOf = (values: PortValue[] | undefined, kind: Material['kind']): Material[] =>
  (values ?? [])
    .filter((value) => value.type === kind)
    .map((value) => ({ assetId: (value as { assetId: string }).assetId, kind }))

/** 素材在画布上的名字：连线的上游元素、@ 引用的名字，最后退回资产自己的文件名 */
function nameOf(input: MediaRequirementsInput, material: Material): string | undefined {
  for (const values of Object.values(input.inputs)) {
    for (const value of values) {
      if (value.type !== 'image' && value.type !== 'video' && value.type !== 'audio') continue
      if (value.assetId !== material.assetId) continue
      const source = value.source
      if (source) {
        const element = input.doc.get(source)
        if (element?.name) return element.name
      }
    }
  }
  const detail = input.details?.find(
    (item) => item.sent.includes(material.assetId) || item.available.includes(material.assetId),
  )
  if (detail?.name) return detail.name
  return input.host.assetInfo(input.ownerId, material.assetId)?.name
}

/** 参考视频按哪种任务模式检查（如编辑参考视频的最短时长） */
const videoTaskOf = (params: Record<string, unknown>): string | undefined => {
  const options = params.options as Record<string, Record<string, unknown>> | undefined
  const selected = options?.[String(params.model ?? '')]
  const task = selected?.omni_reference_task_type
  return typeof task === 'string' ? task : undefined
}

/**
 * 检查实际送入模型的素材；返回中文问题清单，空数组表示都满足。
 * 只看模型声明与素材本身，不联网。
 */
export async function mediaRequirementIssues(input: MediaRequirementsInput): Promise<string[]> {
  const requirements = input.model?.limits?.media
  if (!requirements) return []
  const title = input.model?.title ?? '当前模型'
  const params = input.params
  const issues: string[] = []

  /** 一类素材：取资产记录里的信息，需要时再探测编码 */
  const sampleOf = async (material: Material, needProbe: boolean): Promise<MediaSample> => {
    const asset = input.host.assetInfo(input.ownerId, material.assetId)
    const probe = needProbe
      ? await probeMedia(input.host, input.ownerId, material.assetId, input.signal)
      : undefined
    return {
      ...(asset?.mime ? { mime: asset.mime } : {}),
      ...(typeof asset?.size === 'number' ? { size: asset.size } : {}),
      ...(typeof asset?.width === 'number' ? { width: asset.width } : {}),
      ...(typeof asset?.height === 'number' ? { height: asset.height } : {}),
      ...(typeof asset?.duration === 'number' ? { duration: asset.duration } : {}),
      ...probe,
    }
  }

  const check = async (
    kind: 'image' | 'video' | 'audio' | 'process',
    materials: Material[],
    label: string,
    task?: string,
  ) => {
    const requirement = mediaRequirementOf(requirements, kind, task)
    if (!requirement) return
    const needsProbe =
      requirement.videoCodecs !== undefined ||
      requirement.minFrameRate !== undefined ||
      requirement.maxFrameRate !== undefined ||
      requirement.audioCodecs !== undefined
    const samples: Array<{ sample: MediaSample; name?: string }> = []
    for (const material of materials) {
      const name = nameOf(input, material)
      samples.push({ sample: await sampleOf(material, needsProbe), ...(name ? { name } : {}) })
    }
    issues.push(
      ...mediaBatchProblems({
        requirement,
        samples,
        title,
        label,
        ...(kind === 'video' ? outputOf(params) : {}),
      }),
    )
  }

  if (input.capability === 'video.generate') {
    const mode = String(params.mode ?? 'text')
    // 图片：多模态参考模式是参考图，其余模式是首尾帧，两者都要符合模型的图片要求
    if (mode !== 'text') await check('image', materialsOf(input.inputs.images, 'image'), '参考图片')
    if (mode === 'reference') {
      const task = videoTaskOf(params)
      await check('video', materialsOf(input.inputs.videos, 'video'), '参考视频', task)
      await check('audio', materialsOf(input.inputs.audios, 'audio'), '参考音频')
    }
  }
  if (input.capability === 'image.process')
    await check('process', materialsOf(input.inputs.image, 'image'), '精修原图')

  return issues
}

/**
 * 输出的时长（秒）：与参考视频总时长相加时要算进去。
 * 由模型决定输出时长时（自适应时长或 -1）不与参考素材相加。
 */
function outputOf(params: Record<string, unknown>): {
  outputDuration?: number
  outputDurationByModel: boolean
} {
  const duration = params.duration
  const options = params.options as Record<string, Record<string, unknown>> | undefined
  const selected = options?.[String(params.model ?? '')]
  const byModel =
    duration === -1 ||
    selected?.adaptive_duration === true ||
    videoTaskOverrides(params).duration === -1
  return {
    ...(typeof duration === 'number' && duration !== -1 ? { outputDuration: duration } : {}),
    outputDurationByModel: byModel,
  }
}
