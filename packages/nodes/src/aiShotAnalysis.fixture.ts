import type { AiDraftReference } from './aiShotAnalysis'
export const aiFixture = (): AiDraftReference => ({
  origin: { canvasId: 'canvas', nodeId: 'analysis', resultId: 'result' },
  value: {
    version: 1,
    kind: 'ai-scene-draft',
    promptVersion: 'sample-frame-v1',
    model: { ref: 'mock:vision' },
    request: {
      id: 'request',
      modelRef: 'mock:vision',
      focus: '画面',
      scope: {
        origin: {
          canvasId: 'canvas',
          nodeId: 'local',
          resultId: 'manifest',
          digest: 'e'.repeat(64),
        },
        source: { assetId: 'a'.repeat(64), kind: 'video', mime: 'video/mp4' },
        duration: 3,
        totalScenes: 3,
        firstVideoPts: 5,
        timeBasis: 'first-video-frame',
        scene: {
          id: 'scene-1',
          start: 0,
          end: 1,
          frame: {
            assetId: 'b'.repeat(64),
            kind: 'image',
            mime: 'image/jpeg',
            at: 0.5,
            actualAt: 0,
            actualEnd: 1,
          },
        },
      },
    },
    evidence: {
      visual: 'one-frame-submitted',
      audio: 'unknown',
      motion: 'unknown',
      fullVideoRead: false,
    },
    draft: {
      description: '模型草稿',
      visualDraft: [],
      inferences: ['不确定'],
      unknowns: ['声音未知'],
    },
  },
})
