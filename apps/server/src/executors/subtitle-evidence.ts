import type { ComposeSpec, SubtitlePlanEvidence } from '@plein/plugin-sdk'

/** Copy before compose awaits: this is the exact used spec, never a reconstruction from a live doc. */
export function freezeSubtitleEvidence(spec: ComposeSpec): SubtitlePlanEvidence | undefined {
  const cues = spec.subtitles?.cues ?? []
  if (cues.length > 5000) return undefined
  const evidence: SubtitlePlanEvidence = {
    version: 1,
    basis: 'executed-sequence-spec',
    enabled: !!spec.subtitles,
    // 证据必须与实际烧录的字幕逐条一致，连同句子 id、来源与时间来源一起留档
    cues: cues.map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: cue.text,
      ...(cue.id !== undefined ? { id: cue.id } : {}),
      ...(cue.source !== undefined ? { source: cue.source } : {}),
      ...(cue.origin !== undefined ? { origin: cue.origin } : {}),
    })),
  }
  return Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= 128 * 1024 ? evidence : undefined
}
