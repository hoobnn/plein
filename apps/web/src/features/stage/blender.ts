import { StageScene, stageTime, type StageScene as Scene } from '@plein/nodes'

/** Versioned, self-contained interchange: never embeds credentials or canvas data. */
export function blenderStageDocument(name: string, scene: Scene, time: number) {
  const parsed = StageScene.parse(scene)
  return {
    format: 'plein.stage',
    version: 1,
    name: name.slice(0, 120),
    time: parsed.motion ? stageTime(parsed, time) : 0,
    scene: parsed,
  }
}

export function downloadBlenderStage(name: string, scene: Scene, time: number) {
  const json = JSON.stringify(blenderStageDocument(name, scene, time), null, 2)
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${(name || 'Plein 构图').replace(/[\\/:*?"<>|]/g, '_')}.plein-stage.json`
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
