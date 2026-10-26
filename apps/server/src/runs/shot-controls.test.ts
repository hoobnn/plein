import { syncExpanded } from '@plein/capabilities'
import { planParams, planVersion, Shot } from '@plein/nodes'
import { mockProvider } from '@plein/providers'
import { expect, it, vi } from 'vite-plus/test'
import {
  applyControlDraft,
  buildControlDraft,
  EMPTY_CONTROLS,
  shotControlContext,
} from '../../../web/src/features/storyboard/shotControlModel'
import { addNode, bootServer, createCanvas, mockModel, mockSettings } from '../testing'

it('控制草稿和显式同步零提交，手动运行的实际mock Provider输入保持模型并匹配建议', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const shot = Shot.parse({
    id: 'one',
    no: 1,
    duration: 3,
    description: '保留原剧情',
    motionPrompt: '原运动手改',
    lighting: '原光影',
  })
  const boardId = addNode(doc, 'plein/storyboard', { params: { shots: [shot] } })
  const original = planParams(shot, 'video')
  const model = mockModel('video.generate')
  const videoId = addNode(doc, 'plein/video', {
    params: {
      ...original,
      model,
      mode: 'text',
      source: {
        storyboard: boardId,
        shot: shot.id,
        role: 'video',
        plan: { version: planVersion([shot]), params: original, keep: [] },
      },
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  try {
    const context = shotControlContext(doc, boardId, shot.id, null)!
    const draft = buildControlDraft(context, 'video', {
      ...EMPTY_CONTROLS,
      cameraMotion: '相机缓慢横移',
      subjectMotion: '主体不转身',
      lightPosition: '左后方',
      lightDirection: '照向右前方',
    })
    expect(
      applyControlDraft(doc, boardId, shot.id, null, draft, ['motionPrompt', 'lighting']),
    ).toBe(true)
    expect(doc.get(videoId)!.params!.prompt).toBe(original.prompt)
    syncExpanded(doc, boardId, [shot.id], 'unmodified')
    expect(submit).not.toHaveBeenCalled()
    const preview = await server.runs.preview(id, videoId, 'local')
    expect(preview.status).toBe('ready')
    expect(preview.prompt).toContain('原运动手改；相机运动：相机缓慢横移；主体动作：主体不转身')
    expect(preview.prompt).toContain('光源位置：左后方；照射方向：照向右前方')
    expect(preview.model!.ref).toBe(model)
    expect(await server.runs.wait(server.runs.start(id, videoId, 'local'))).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).toMatchObject({
      capability: 'video.generate',
      model: mockProvider.models.find((m) => m.capabilities.includes('video.generate'))!.id,
      input: { prompt: preview.prompt, duration: 3 },
    })
    expect(doc.get(videoId)!.params!.model).toBe(model)
  } finally {
    submit.mockRestore()
    doc.destroy()
  }
})
