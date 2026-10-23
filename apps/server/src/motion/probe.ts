import { isAbsolute } from 'node:path'
import { MotionError, runTool } from './process'

export interface MotionRuntime {
  ffmpeg: string
  ffprobe: string
  useGpu: boolean
  encoder:
    | 'libvpx-vp9'
    | 'libx264'
    | 'h264_videotoolbox'
    | 'h264_nvenc'
    | 'h264_vaapi'
    | 'h264_qsv'
    | 'h264_amf'
  ffmpegVersion: string
  ffprobeVersion: string
}

/** Probe the exact binaries shipped by the host, including one real encoded frame. */
export async function probeMotionRuntime(
  input: { ffmpeg: string; ffprobe: string; output?: 'mp4' | 'transparent-webm' },
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<MotionRuntime> {
  if (!isAbsolute(input.ffmpeg) || !isAbsolute(input.ffprobe))
    throw new MotionError(
      'motion_runtime_unavailable',
      'Motion rendering requires absolute ffmpeg and ffprobe paths',
    )
  const [encoders, ffmpeg, ffprobe] = await Promise.all([
    runTool(input.ffmpeg, ['-hide_banner', '-encoders'], options),
    runTool(input.ffmpeg, ['-version'], options),
    runTool(input.ffprobe, ['-version'], options),
  ])
  const names =
    input.output === 'transparent-webm'
      ? (['libvpx-vp9'] as const)
      : ([
          'libx264',
          'h264_nvenc',
          'h264_videotoolbox',
          'h264_vaapi',
          'h264_qsv',
          'h264_amf',
        ] as const)
  const failures: string[] = []
  for (const encoder of names) {
    if (!new RegExp(`^\\s*V\\S*\\s+${encoder}\\s`, 'm').test(encoders.stdout)) continue
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=size=320x240:rate=1:duration=1',
      '-frames:v',
      '1',
      '-an',
    ]
    if (encoder === 'libvpx-vp9') args.push('-vf', 'format=yuva420p')
    if (encoder === 'h264_vaapi')
      args.push('-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload')
    args.push('-c:v', encoder)
    if (encoder === 'h264_videotoolbox') args.push('-b:v', '1M', '-allow_sw', '1')
    if (encoder === 'h264_amf') args.push('-rc', 'cqp', '-qp_i', '28', '-qp_p', '28')
    args.push('-f', 'null', '-')
    try {
      await runTool(input.ffmpeg, args, { ...options, timeoutMs: 10_000 })
      return {
        ...input,
        encoder,
        useGpu: encoder !== 'libx264' && encoder !== 'libvpx-vp9',
        ffmpegVersion: ffmpeg.stdout.split('\n')[0]!,
        ffprobeVersion: ffprobe.stdout.split('\n')[0]!,
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      failures.push(`${encoder}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new MotionError(
    'motion_encoder_unavailable',
    `The configured ffmpeg has no working ${input.output === 'transparent-webm' ? 'VP9 alpha (libvpx-vp9)' : 'H.264'} encoder compatible with HyperFrames. ${failures.join('; ')}`,
  )
}
