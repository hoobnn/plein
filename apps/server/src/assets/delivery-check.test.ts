import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyProductionGoal, productionGoalSnapshot } from '@plein/doc'
import { DELIVERY_CHECK_LIMITS, DeliveryCheckReport, type DeliveryCheckRequest } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, tempDir, until } from '../testing'
import { checkVideo } from './delivery-check'
import { ffmpegBin, hasFfmpeg, setMediaTools } from './media'

const available = await hasFfmpeg()
function make(directory: string, video: string, audio: 'tone' | 'silence' | 'none' = 'tone') {
  const file = join(directory, `${video.replaceAll(/\W/g, '').slice(0, 30)}-${audio}.mp4`)
  execFileSync(ffmpegBin(), [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    video,
    ...(audio === 'none'
      ? []
      : [
          '-f',
          'lavfi',
          '-i',
          audio === 'tone' ? 'sine=frequency=440:duration=2' : 'anullsrc=r=48000:cl=stereo:d=2',
        ]),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(audio === 'none' ? ['-an'] : ['-c:a', 'aac', '-shortest']),
    file,
  ])
  return file
}
async function fixture(file: string) {
  const { server } = await bootServer()
  const asset = await server.assets.ingest('local', createReadStream(file), {
    name: 'export.mp4',
    mime: 'video/mp4',
  })
  const source = { assetId: asset.id, kind: 'video' as const, mime: asset.mime }
  const goal = {
    ...emptyProductionGoal(),
    aspectRatio: '16:9' as const,
    resolution: '720p' as const,
    duration: { min: 1.8, max: 2.2 },
    dialogue: 'required' as const,
  }
  const request: DeliveryCheckRequest = {
    scope: { canvasId: 'canvas', boardId: 'board', sequenceId: 'sequence' },
    deliveryId: 'delivery',
    runId: 'export-run',
    resultId: 'export-result',
    source,
    goal: { id: 'goal-v1', snapshot: productionGoalSnapshot(goal) },
    subtitles: {
      version: 1,
      basis: 'executed-sequence-spec',
      enabled: false,
      cues: [],
      assetId: asset.id,
      resultId: 'export-result',
    },
  }
  const run = (value = request, signal = new AbortController().signal) =>
    checkVideo(server.assets, 'local', source, value, signal, () => {})
  return { server, source, goal, request, run }
}

describe.skipIf(!available)('实际成片技术检查', () => {
  it('完整真实解码、像素规格/时长/轨道与哈希；重复静帧不宣称实际动作', async () => {
    const f = await fixture(make(tempDir(), 'color=yellow:s=1280x720:r=10:d=2'))
    const report = await f.run()
    expect(report.status).toBe('passed')
    const actual = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_frames,duration',
          '-of',
          'json',
          f.server.assets.originalPath(f.source.assetId),
        ],
        { encoding: 'utf8' },
      ),
    ).streams[0]
    expect(report.observed).toMatchObject({
      sha256: f.source.assetId,
      width: 1280,
      height: 720,
      audioTracks: 1,
      audioDecoded: true,
      decodedFrames: Number(actual.nb_read_frames),
      complete: true,
    })
    expect(report.observed.duration).toBeCloseTo(Number(actual.duration), 2)
    expect(report.unchecked.join(' ')).toContain('重复静帧')
    expect(report.unchecked.join(' ')).toContain('不证明对白')
    expect(DeliveryCheckReport.safeParse(report).success).toBe(true)
  })

  it('缺音轨是目标要求的问题；旧输出没有字幕计划保持未检查', async () => {
    const f = await fixture(make(tempDir(), 'color=yellow:s=1280x720:r=10:d=2', 'none'))
    const { subtitles: _, ...old } = f.request
    const report = await f.run(old)
    expect(report.status).toBe('issues')
    expect(report.checks.find((c) => c.id === 'audio')?.status).toBe('issues')
    expect(report.checks.find((c) => c.id === 'subtitles')?.status).toBe('unchecked')
    expect(report.checks.find((c) => c.id === 'silence')?.status).toBe('unchecked')
  })

  it('黑场与静音候选保留实际区间；两个明确允许目标变体不制造人工通过', async () => {
    for (const kind of ['black', 'silence'] as const) {
      const f = await fixture(
        make(
          tempDir(),
          `color=${kind === 'black' ? 'black' : 'yellow'}:s=1280x720:r=10:d=2`,
          kind === 'silence' ? 'silence' : 'tone',
        ),
      )
      const report = await f.run()
      expect(report.observed[kind].length).toBeGreaterThan(0)
      expect(report.observed[kind][0]!.start).toBeLessThan(0.1)
      expect(report.observed[kind][0]!.end).toBeGreaterThan(1.8)
      expect(report.checks.find((c) => c.id === kind)?.status).toBe('issues')
      const allowed = await f.run({
        ...f.request,
        goal: {
          id: 'allowed-version',
          snapshot: productionGoalSnapshot({
            ...f.goal,
            [kind === 'black' ? 'allowBlack' : 'allowSilence']: true,
          }),
        },
      })
      expect(allowed.checks.find((c) => c.id === kind)?.status).toBe('passed')
      expect(allowed.unchecked).not.toHaveLength(0)
      expect(JSON.stringify(allowed)).not.toContain('confirmedAt')
    }
  })

  it('真实文件与绑定的执行字幕计划比较区间，不能拿当前字幕替代', async () => {
    const f = await fixture(make(tempDir(), 'color=yellow:s=1280x720:r=10:d=2'))
    const report = await f.run({
      ...f.request,
      subtitles: {
        ...f.request.subtitles!,
        enabled: true,
        cues: [{ start: 1.8, end: 3, text: '越过实际文件的计划' }],
      },
    })
    expect(report.checks.find((c) => c.id === 'subtitles')?.status).toBe('issues')
    expect(report.request.subtitles!.cues[0]!.end).toBe(3)
    await expect(
      f.run({ ...f.request, subtitles: { ...f.request.subtitles!, resultId: 'another-output' } }),
    ).rejects.toThrow('不属于')
    const unwanted = await f.run({
      ...f.request,
      goal: {
        id: 'no-subtitles',
        snapshot: productionGoalSnapshot({ ...f.goal, subtitles: 'none' }),
      },
      subtitles: {
        ...f.request.subtitles!,
        enabled: true,
        cues: [{ start: 0, end: 1, text: '实际执行计划有字幕' }],
      },
    })
    expect(unwanted.checks.find((check) => check.id === 'subtitles')?.status).toBe('issues')
  })

  it('晚开始/早结束音轨明确列出样本未覆盖区间，不能宣称整片无静音', async () => {
    for (const offset of [0, 0.5]) {
      const file = join(tempDir(), 'partial-audio.mp4')
      execFileSync(ffmpegBin(), [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=yellow:s=1280x720:r=10:d=2',
        '-itsoffset',
        String(offset),
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        file,
      ])
      const f = await fixture(file),
        report = await f.run()
      expect(report.observed.audioUncovered?.length).toBeGreaterThan(0)
      expect(report.checks.find((check) => check.id === 'silence')?.status).toBe('unchecked')
      expect(report.observed.audioUncovered!.some((interval) => interval.end > 1.8)).toBe(true)
      if (offset) expect(report.observed.audioUncovered![0]!.start).toBe(0)
    }
  })

  it('非零PTS、VFR与旋转按实际解码时钟/显示尺寸记录，不用容器起点推断', async () => {
    const directory = tempDir(),
      base = make(directory, 'color=yellow:s=1280x720:r=10:d=2')
    for (const kind of ['offset', 'vfr', 'rotation'] as const) {
      const file = join(directory, `${kind}.mp4`)
      const args =
        kind === 'offset'
          ? ['-copyts', '-itsoffset', '5', '-i', base, '-c', 'copy']
          : kind === 'rotation'
            ? ['-display_rotation:v:0', '90', '-i', base, '-c', 'copy']
            : [
                '-i',
                base,
                '-vf',
                "select='not(eq(n,7)+eq(n,8))'",
                '-fps_mode',
                'vfr',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-c:a',
                'copy',
              ]
      execFileSync(ffmpegBin(), ['-v', 'error', '-y', ...args, file])
      const f = await fixture(file),
        report = await f.run()
      expect(report.observed.complete).toBe(true)
      expect(report.observed.duration).toBeCloseTo(2, 1)
      if (kind === 'offset') expect(report.observed.firstVideoPts).toBeCloseTo(5, 1)
      if (kind === 'vfr') expect(report.observed.decodedFrames).toBe(18)
      if (kind === 'rotation') {
        expect(report.observed).toMatchObject({ width: 720, height: 1280 })
        expect(report.checks.find((check) => check.id === 'spec')?.status).toBe('issues')
      }
    }
  })

  it('缺少实际末帧持续时间时保留完整解码，但不能用上一帧PTS间隔猜时长', async () => {
    const directory = tempDir(),
      f = await fixture(make(directory, 'color=yellow:s=1280x720:r=10:d=2')),
      real = ffmpegBin(),
      wrapper = join(directory, 'without-frame-duration.cjs')
    await writeFile(
      wrapper,
      `#!${process.execPath}\nconst {spawn}=require('node:child_process');const child=spawn(${JSON.stringify(real)},process.argv.slice(2),{stdio:['ignore','inherit','pipe']});let pending='';child.stderr.on('data',data=>{pending+=data;const lines=pending.split(/\\r?\\n/);pending=lines.pop()||'';for(const line of lines)process.stderr.write(line.replace(/\\bduration_time:[\\d.e+-]+/g,'')+'\\n')});child.on('close',code=>{process.stderr.write(pending.replace(/\\bduration_time:[\\d.e+-]+/g,''));process.exit(code||0)});process.on('SIGTERM',()=>child.kill('SIGTERM'));\n`,
      { mode: 0o700 },
    )
    try {
      setMediaTools({ ffmpeg: wrapper, ffprobe: 'ffprobe' })
      const report = await f.run()
      expect(report.status).toBe('unchecked')
      expect(report.observed).toMatchObject({ complete: true, decodedFrames: 20 })
      expect(report.observed.duration).toBeUndefined()
      expect(report.checks.find((check) => check.id === 'decode')?.status).toBe('passed')
      for (const id of ['duration', 'subtitles', 'black', 'silence'])
        expect(report.checks.find((check) => check.id === id)?.status).toBe('unchecked')
    } finally {
      setMediaTools({ ffmpeg: real, ffprobe: 'ffprobe' })
    }
    expect((await f.run()).status).toBe('passed')
  })

  it('帧数/尺寸/时长/报告预算故障注入不发布部分通过，后续任务可正常检查', async () => {
    const f = await fixture(make(tempDir(), 'color=yellow:s=1280x720:r=10:d=2'))
    const limits = DELIVERY_CHECK_LIMITS as {
      frames: number
      dimension: number
      duration: number
      reportBytes: number
    }
    for (const key of ['frames', 'dimension', 'duration'] as const) {
      const original = limits[key]
      try {
        limits[key] = 1
        const report = await f.run()
        expect(report.status).toBe('failed')
        expect(report.observed.complete).toBe(false)
      } finally {
        limits[key] = original
      }
    }
    const original = limits.reportBytes
    try {
      limits.reportBytes = 1
      await expect(f.run()).rejects.toThrow('报告超过')
    } finally {
      limits.reportBytes = original
    }
    expect((await f.run()).status).toBe('passed')
  })

  it('解码子进程不响应TERM时取消会强杀并等待close，不遗留进程或发布部分报告', async () => {
    const directory = tempDir(),
      f = await fixture(make(directory, 'color=yellow:s=1280x720:r=10:d=2'))
    const mock = join(directory, 'hung-ffmpeg.cjs'),
      pidFile = join(directory, 'ffmpeg.pid'),
      real = ffmpegBin()
    await writeFile(
      mock,
      `#!${process.execPath}\nif(process.argv.includes('-version')){process.stdout.write('ffmpeg controlled-cancel-test');process.exit(0)};require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\n`,
      { mode: 0o700 },
    )
    const cancel = new AbortController()
    try {
      setMediaTools({ ffmpeg: mock, ffprobe: 'ffprobe' })
      const running = f.run(f.request, cancel.signal)
      await until(() => existsSync(pidFile))
      const pid = Number(await readFile(pidFile, 'utf8'))
      cancel.abort(new Error('cancel decoder'))
      await expect(running).rejects.toThrow('cancel decoder')
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      cancel.abort()
      setMediaTools({ ffmpeg: real, ffprobe: 'ffprobe' })
    }
    expect((await f.run()).status).toBe('passed')
  })

  it('损坏视频产生检查失败，超限不发部分通过，下一次检查仍可执行', async () => {
    const directory = tempDir(),
      broken = join(directory, 'broken.mp4')
    await writeFile(broken, 'broken video')
    const bad = await fixture(broken)
    const report = await bad.run()
    expect(report.status).toBe('failed')
    expect(report.observed.complete).toBe(false)
    const f = await fixture(make(directory, 'color=yellow:s=1280x720:r=10:d=2'))
    const limits = DELIVERY_CHECK_LIMITS as { inputBytes: number }
    const original = limits.inputBytes
    try {
      limits.inputBytes = 1
      expect((await f.run()).status).toBe('failed')
    } finally {
      limits.inputBytes = original
    }
    expect((await f.run()).status).toBe('passed')
  })

  it('挂起探针取消/排队取消等待实际close后释放P12槽，超时也不产生报告', async () => {
    const directory = tempDir()
    const f = await fixture(make(directory, 'color=yellow:s=1280x720:r=10:d=2'))
    const probe = join(directory, 'probe.cjs'),
      pidFile = join(directory, 'probe.pid')
    await writeFile(
      probe,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)\n`,
      { mode: 0o700 },
    )
    const ffmpeg = ffmpegBin(),
      cancel = new AbortController(),
      queued = new AbortController()
    try {
      setMediaTools({ ffmpeg, ffprobe: probe })
      const active = f.run(f.request, cancel.signal)
      await until(() => existsSync(pidFile))
      const waiting = f.run(f.request, queued.signal)
      queued.abort(new Error('queued canceled'))
      await expect(waiting).rejects.toThrow('queued canceled')
      cancel.abort(new Error('active canceled'))
      await expect(active).rejects.toThrow('active canceled')
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      const limits = DELIVERY_CHECK_LIMITS as { timeoutMs: number },
        original = limits.timeoutMs
      try {
        limits.timeoutMs = 100
        await expect(f.run()).rejects.toThrow()
      } finally {
        limits.timeoutMs = original
      }
    } finally {
      cancel.abort()
      queued.abort()
      setMediaTools({ ffmpeg, ffprobe: 'ffprobe' })
    }
    expect((await f.run()).status).toBe('passed')
    expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0)
  })
})
