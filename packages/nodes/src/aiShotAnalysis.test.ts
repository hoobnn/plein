import { describeNode, withDefaultModel } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import {
  AiLocalScope,
  AiSceneResult,
  AiSummaryRequest,
  aiSceneNode,
  aiSummaryNode,
  aiAnalysisAssets,
} from './aiShotAnalysis'

import { aiFixture } from './aiShotAnalysis.fixture'
describe('P09有界数据与证据合同', () => {
  it('目录自动默认不能开启AI模型；执行结果只声明所送静帧', () => {
    for (const node of [aiSceneNode, aiSummaryNode])
      expect(
        withDefaultModel(describeNode(node, 'plein/core'), () => 'configured:auto').defaults.model,
      ).toBe('')
    expect(AiSceneResult.safeParse(aiFixture().value).success).toBe(true)
    const bad = aiFixture().value as unknown as { evidence: { audio: string } }
    bad.evidence.audio = 'heard'
    expect(AiSceneResult.safeParse(bad).success).toBe(false)
  })
  it('非法区间、帧时间和范围外引用不能声明为有据采样', () => {
    const scope = aiFixture().value.request.scope
    expect(AiLocalScope.safeParse({ ...scope, scene: { ...scope.scene, end: 0 } }).success).toBe(
      false,
    )
    expect(
      AiLocalScope.safeParse({
        ...scope,
        scene: { ...scope.scene, frame: { ...scope.scene.frame, at: 1 } },
      }).success,
    ).toBe(false)
    expect(
      AiLocalScope.safeParse({
        ...scope,
        scene: { ...scope.scene, frame: { ...scope.scene.frame, actualAt: 0.6 } },
      }).success,
    ).toBe(false)
  })
  it('归纳最多3镜，不混本地版本/源视频或重复镜头，资产扫描只取typed来源', () => {
    const first = aiFixture(),
      second = aiFixture()
    second.value.request.scope.scene.id = 'scene-2'
    const request = { id: 'summary', modelRef: 'mock:text', focus: '', drafts: [first, second] }
    expect(AiSummaryRequest.safeParse(request).success).toBe(true)
    for (const key of ['canvasId', 'nodeId', 'resultId'] as const) {
      second.value.request.scope.origin[key] = 'same-digest-different-source'
      expect(AiSummaryRequest.safeParse(request).success).toBe(false)
      second.value.request.scope.origin[key] = first.value.request.scope.origin[key]
    }
    expect(AiSummaryRequest.safeParse({ ...request, drafts: [first, first] }).success).toBe(false)
    expect(
      AiSummaryRequest.safeParse({ ...request, drafts: [first, second, first, second] }).success,
    ).toBe(false)
    second.value.request.scope.origin.digest = 'f'.repeat(64)
    expect(AiSummaryRequest.safeParse(request).success).toBe(false)
    expect(aiAnalysisAssets(first.value)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(aiAnalysisAssets({ assetId: 'a'.repeat(64) })).toEqual([])
  })
})
