import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connect, currentResult, setParam } from '@plein/doc'
import { SHOT_ANALYSIS_TYPE, SHOT_ANALYSIS_LIMITS, ShotAnalysisManifest } from '@plein/nodes'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, tempDir, until } from '../testing'
import { analyzeVideo } from './shot-analysis'
import { ffmpegBin, hasFfmpeg, probeMedia, setMediaTools, withMediaAbort } from './media'
import { documentReferences } from '../media-index/references'

const available = await hasFfmpeg()
const settings = { threshold: 0.25, minSceneSeconds: 0.4, clips: false, audio: false }
function makeVideo(directory: string, args: string[], name = 'source.mp4') {
  const file = join(directory, name)
  execFileSync(ffmpegBin(), ['-v', 'error', '-y', ...args, file])
  return file
}

describe.skipIf(!available)('本地拉片真实媒体', () => {
  it('VFR末帧持续缺失时拒绝全片覆盖，不能沿用上一帧持续或PTS差估算', async () => {
    const { server, dataDir } = await bootServer()
    const directory = tempDir()
    const file = makeVideo(directory, [
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x48:r=10:d=0.3',
      '-vf',
      'setpts=if(eq(N\\,2)\\,1/TB\\,N/(10*TB))',
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
    ])
    const source = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'tail-vfr.mp4',
    })
    const ref = { assetId: source.id, kind: 'video' as const }
    const actual = await analyzeVideo(
      server.assets,
      'local',
      ref,
      settings,
      new AbortController().signal,
      () => {},
    )
    const originalProbe = execFileSync('which', ['ffprobe'], { encoding: 'utf8' }).trim()
    const decoded = JSON.parse(
      execFileSync(
        originalProbe,
        [
          '-v',
          'error',
          '-select_streams',
          'V:0',
          '-show_frames',
          '-show_entries',
          'frame=pts_time,duration_time',
          '-of',
          'json',
          file,
        ],
        { encoding: 'utf8' },
      ),
    ) as { frames: Array<{ pts_time: string; duration_time: string }> }
    const lastFrame = decoded.frames.at(-1)!
    // Container duration may disagree with the presented final packet; compare actual frames.
    expect(actual.duration).toBeCloseTo(
      Number(lastFrame.pts_time) -
        Number(decoded.frames[0]!.pts_time) +
        Number(lastFrame.duration_time),
      6,
    )
    const originalFfmpeg = ffmpegBin()
    const wrapper = join(directory, 'omit-last-duration.cjs')
    await writeFile(
      wrapper,
      `#!${process.execPath}\nconst r=require('node:child_process').spawnSync(${JSON.stringify(originalFfmpeg)},process.argv.slice(2),{maxBuffer:64*1024*1024});const lines=String(r.stderr??'').split('\\n');let last=-1;for(let i=0;i<lines.length;i++)if(lines[i].includes('showinfo@all')&&/\\bpts_time:/.test(lines[i]))last=i;if(last>=0)lines[last]=lines[last].replace(/\\bduration_time:[\\d.e+-]+/g,'');process.stdout.write(r.stdout??'');process.stderr.write(lines.join('\\n'));process.exit(r.status??1);\n`,
      { mode: 0o700 },
    )
    try {
      setMediaTools({ ffmpeg: wrapper, ffprobe: originalProbe })
      await expect(
        analyzeVideo(server.assets, 'local', ref, settings, new AbortController().signal, () => {}),
      ).rejects.toThrow('无法确定末帧持续时间')
      expect(await readdir(join(dataDir, 'tmp'))).toEqual([])
    } finally {
      setMediaTools({ ffmpeg: originalFfmpeg, ffprobe: originalProbe })
    }
    expect(
      (
        await analyzeVideo(
          server.assets,
          'local',
          ref,
          settings,
          new AbortController().signal,
          () => {},
        )
      ).duration,
    ).toBeCloseTo(actual.duration, 6)
  }, 30_000)

  it('挂起的ffprobe随取消终止并释放唯一槽，排队取消不阻塞下一次真实分析', async () => {
    const { server, dataDir } = await bootServer()
    const directory = tempDir()
    const file = makeVideo(directory, [
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x48:r=2:d=1',
      '-c:v',
      'libx264',
    ])
    const source = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'good.mp4',
    })
    const ref = { assetId: source.id, kind: 'video' as const }
    const probe = join(directory, 'hung-probe.cjs')
    const pidFile = join(directory, 'probe.pid')
    await writeFile(
      probe,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)\n`,
      { mode: 0o700 },
    )
    const cancel = new AbortController()
    const waiting = new AbortController()
    const originalFfmpeg = ffmpegBin()
    try {
      setMediaTools({ ffmpeg: originalFfmpeg, ffprobe: probe })
      const held = analyzeVideo(server.assets, 'local', ref, settings, cancel.signal, () => {})
      await until(() => existsSync(pidFile))
      const next = analyzeVideo(
        server.assets,
        'local',
        ref,
        settings,
        new AbortController().signal,
        () => {},
      )
      const canceledWaiter = analyzeVideo(
        server.assets,
        'local',
        ref,
        settings,
        waiting.signal,
        () => {},
      )
      waiting.abort(new Error('cancel queued'))
      await expect(canceledWaiter).rejects.toThrow('cancel queued')
      setMediaTools({ ffmpeg: originalFfmpeg, ffprobe: 'ffprobe' })
      cancel.abort(new Error('cancel probe'))
      await expect(held).rejects.toThrow('cancel probe')
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      expect((await next).scenes).toHaveLength(1)
      expect(await readdir(join(dataDir, 'tmp'))).toEqual([])
    } finally {
      cancel.abort()
      waiting.abort()
      setMediaTools({ ffmpeg: originalFfmpeg, ffprobe: 'ffprobe' })
    }
  }, 30_000)

  it('取消任务的局部能力探测不污染全局可用性缓存', async () => {
    const directory = tempDir()
    const probe = join(directory, 'one-hung-probe.cjs')
    const pidFile = join(directory, 'probe.pid')
    const originalFfmpeg = ffmpegBin()
    const actualProbe = execFileSync('which', ['ffprobe'], { encoding: 'utf8' }).trim()
    await writeFile(
      probe,
      `#!${process.execPath}\nconst fs=require('node:fs'); if(!fs.existsSync(${JSON.stringify(pidFile)})){fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)} else {const r=require('node:child_process').spawnSync(${JSON.stringify(actualProbe)},process.argv.slice(2));process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1)}\n`,
      { mode: 0o700 },
    )
    const cancel = new AbortController()
    try {
      setMediaTools({ ffmpeg: originalFfmpeg, ffprobe: probe })
      const probing = withMediaAbort(cancel.signal, () => hasFfmpeg())
      await until(() => existsSync(pidFile))
      cancel.abort(new Error('cancel availability'))
      await expect(probing).rejects.toThrow('cancel availability')
      expect(await hasFfmpeg()).toBe(true)
      expect(await hasFfmpeg()).toBe(true)
    } finally {
      cancel.abort()
      setMediaTools({ ffmpeg: originalFfmpeg, ffprobe: 'ffprobe' })
    }
  }, 30_000)

  it('检测硬切、提取片段和原音轨，输出语义有效清单与源时间区间', async () => {
    const { server, dataDir } = await bootServer()
    const directory = tempDir('plein-shot-analysis-')
    const file = makeVideo(directory, [
      '-f',
      'lavfi',
      '-i',
      'color=red:s=96x64:r=10:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=96x64:r=10:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
    ])
    const source = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'source.mp4',
    })
    const manifest = await analyzeVideo(
      server.assets,
      'local',
      { assetId: source.id, kind: 'video' },
      { ...settings, clips: true, audio: true },
      new AbortController().signal,
      () => {},
    )
    expect(ShotAnalysisManifest.safeParse(manifest).success).toBe(true)
    expect(manifest.duration).toBeCloseTo(2, 2)
    expect(manifest.scenes.map((scene) => [scene.start, scene.end])).toEqual([
      [0, 1],
      [1, 2],
    ])
    for (const scene of manifest.scenes) {
      const meta = await probeMedia(server.assets.originalPath(scene.clip!.assetId))
      expect(meta.duration).toBeCloseTo(scene.end - scene.start, 1)
      expect(meta.hasAudio).toBe(true)
      expect(scene.frame.actualAt).toBeLessThanOrEqual(scene.frame.at)
      expect(scene.frame.actualEnd).toBeGreaterThan(scene.frame.at)
    }
    expect(manifest.audio).toBeDefined()
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([])
  }, 30_000)

  it('非零首视频PTS与晚到音轨按同一时间基准对齐，静音间隔经PCM统计验证', async () => {
    const { server } = await bootServer()
    const file = makeVideo(tempDir(), [
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x48:r=10:d=2',
      '-itsoffset',
      '5.5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1.5',
      '-vf',
      'setpts=PTS+5/TB',
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
    ])
    const source = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'offset.mp4',
    })
    const manifest = await analyzeVideo(
      server.assets,
      'local',
      { assetId: source.id, kind: 'video' },
      { ...settings, points: [0.25, 0.75], clips: true, audio: true },
      new AbortController().signal,
      () => {},
    )
    expect(manifest.firstVideoPts).toBeCloseTo(5)
    const rms = (assetId: string, start: number, end: number) => {
      const pcm = execFileSync(ffmpegBin(), [
        '-v',
        'error',
        '-i',
        server.assets.originalPath(assetId),
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        'pipe:1',
      ])
      let sum = 0
      const from = Math.floor(start * 8000)
      const to = Math.floor(end * 8000)
      expect(pcm.byteLength / 4).toBeGreaterThanOrEqual(to)
      for (let index = from; index < to; index++) sum += pcm.readFloatLE(index * 4) ** 2
      return Math.sqrt(sum / (to - from))
    }
    expect(rms(manifest.audio!.assetId, 0.05, 0.4)).toBeLessThan(0.005)
    expect(rms(manifest.audio!.assetId, 0.7, 1.1)).toBeGreaterThan(0.03)
    expect(rms(manifest.scenes[1]!.clip!.assetId, 0.03, 0.15)).toBeLessThan(0.005)
    expect(rms(manifest.scenes[1]!.clip!.assetId, 0.35, 0.45)).toBeGreaterThan(0.03)
  }, 30_000)

  it('单帧与低帧率区间中间无新PTS时仍可取覆盖帧并输出非空片段', async () => {
    const { server } = await bootServer()
    const file = makeVideo(tempDir(), [
      '-f',
      'lavfi',
      '-i',
      'color=green:s=64x48:r=1:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
    ])
    const source = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'low.mp4',
    })
    const manifest = await analyzeVideo(
      server.assets,
      'local',
      { assetId: source.id, kind: 'video' },
      { ...settings, points: [0.2, 0.4], clips: true },
      new AbortController().signal,
      () => {},
    )
    expect(ShotAnalysisManifest.safeParse(manifest).success).toBe(true)
    const tiny = manifest.scenes[1]!
    expect(tiny.frame.at).toBeCloseTo(0.3)
    expect(tiny.frame.actualAt).toBe(0)
    expect(tiny.frame.actualEnd).toBe(1)
    const meta = await probeMedia(server.assets.originalPath(tiny.clip!.assetId))
    expect(meta.duration).toBeCloseTo(0.2, 1)
    expect(meta.hasVideo).toBe(true)
    const pixels = execFileSync(ffmpegBin(), [
      '-v',
      'error',
      '-i',
      server.assets.originalPath(tiny.clip!.assetId),
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ])
    const stats = await sharp(pixels).stats()
    expect(stats.channels[1]!.mean).toBeGreaterThan(90)
    expect(stats.channels[0]!.mean).toBeLessThan(30)
    expect(stats.channels[2]!.mean).toBeLessThan(30)
    await expect(
      analyzeVideo(
        server.assets,
        'local',
        { assetId: source.id, kind: 'video' },
        { ...settings, points: [0.01], clips: true },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('1/30')
    const framesOnly = await analyzeVideo(
      server.assets,
      'local',
      { assetId: source.id, kind: 'video' },
      { ...settings, points: [0.01], clips: false },
      new AbortController().signal,
      () => {},
    )
    expect(framesOnly.scenes[0]!.frame.actualAt).toBe(0)
  }, 30_000)

  it('保留VFR真实PTS和非零起点，旋转素材输出摆正关键帧；无音轨明确说明', async () => {
    const { server } = await bootServer()
    const directory = tempDir()
    const base = makeVideo(
      directory,
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=96x64:r=10:d=2',
        '-vf',
        "select='eq(n,0)+eq(n,1)+eq(n,4)+eq(n,10)+eq(n,17)',setpts=PTS+5/TB",
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
      ],
      'base.mp4',
    )
    const rotated = makeVideo(
      directory,
      ['-copyts', '-display_rotation:v:0', '90', '-i', base, '-c', 'copy'],
      'rotated.mp4',
    )
    const source = await server.assets.ingest('local', createReadStream(rotated), {
      mime: 'video/mp4',
      name: 'rotated.mp4',
    })
    const manifest = await analyzeVideo(
      server.assets,
      'local',
      { assetId: source.id, kind: 'video' },
      { ...settings, points: [0.2, 0.3], clips: true, audio: true },
      new AbortController().signal,
      () => {},
    )
    expect(ShotAnalysisManifest.safeParse(manifest).success).toBe(true)
    expect(manifest.firstVideoPts).toBeGreaterThanOrEqual(5)
    expect(manifest.scenes[0]!.frame.actualAt).toBeCloseTo(0.1)
    expect(manifest.audio).toBeUndefined()
    expect(manifest.notes.join('')).toContain('没有音轨')
    const frame = server.assets.get('local', manifest.scenes[0]!.frame.assetId)!
    expect(frame.width).toBe(64)
    expect(frame.height).toBe(96)
    const held = manifest.scenes[1]!
    expect(held.frame.actualAt).toBeCloseTo(0.1)
    expect(held.frame.actualEnd).toBeCloseTo(0.4)
    const clip = await probeMedia(server.assets.originalPath(held.clip!.assetId))
    expect(clip.hasVideo).toBe(true)
    expect(clip.duration).toBeCloseTo(0.1, 2)
    expect([clip.width, clip.height]).toEqual([64, 96])
  }, 30_000)

  it('单解码帧有代表帧，闪光误切可以人工修正，渐变保留为一个区间并标注算法边界', async () => {
    const { server } = await bootServer()
    const directory = tempDir()
    for (const [name, args, scenes] of [
      [
        'single.mp4',
        ['-f', 'lavfi', '-i', 'color=red:s=64x48:r=1:d=1', '-c:v', 'libx264'],
        [[0, 1]],
      ],
      [
        'flash.mp4',
        [
          '-f',
          'lavfi',
          '-i',
          'color=red:s=64x48:r=10:d=1',
          '-f',
          'lavfi',
          '-i',
          'color=white:s=64x48:r=10:d=0.1',
          '-f',
          'lavfi',
          '-i',
          'color=red:s=64x48:r=10:d=1',
          '-f',
          'lavfi',
          '-i',
          'color=blue:s=64x48:r=10:d=1',
          '-filter_complex',
          '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
          '-map',
          '[v]',
          '-c:v',
          'libx264',
        ],
        [
          [0, 1],
          [1, 2.1],
          [2.1, 3.1],
        ],
      ],
      [
        'fade.mp4',
        [
          '-f',
          'lavfi',
          '-i',
          'color=white:s=64x48:r=20:d=2',
          '-vf',
          'fade=t=in:st=0:d=2',
          '-c:v',
          'libx264',
        ],
        [[0, 2]],
      ],
    ] as const) {
      const file = makeVideo(directory, [...args], name)
      const source = await server.assets.ingest('local', createReadStream(file), {
        mime: 'video/mp4',
        name,
      })
      const manifest = await analyzeVideo(
        server.assets,
        'local',
        { assetId: source.id, kind: 'video' },
        settings,
        new AbortController().signal,
        () => {},
      )
      expect(manifest.scenes.map((scene) => [scene.start, scene.end])).toEqual(scenes)
      expect(ShotAnalysisManifest.safeParse(manifest).success).toBe(true)
      if (name === 'flash.mp4') {
        expect(manifest.notes.join('')).toContain('闪光可能误切')
        const corrected = await analyzeVideo(
          server.assets,
          'local',
          { assetId: source.id, kind: 'video' },
          { ...settings, points: [2.1] },
          new AbortController().signal,
          () => {},
        )
        expect(corrected.scenes.map((scene) => [scene.start, scene.end])).toEqual([
          [0, 2.1],
          [2.1, 3.1],
        ])
      }
    }
  }, 30_000)

  it('真实超长和超分辨率输入在处理前拒绝，输出预算检查清理临时目录', async () => {
    const { server, dataDir } = await bootServer()
    const directory = tempDir()
    for (const [name, size, duration, error] of [
      ['long.mp4', '16x16', 601, '600 秒'],
      ['wide.mp4', '4098x16', 1, '4096'],
    ] as const) {
      const file = makeVideo(
        directory,
        ['-f', 'lavfi', '-i', `color=red:s=${size}:r=1:d=${duration}`, '-c:v', 'libx264'],
        name,
      )
      const source = await server.assets.ingest('local', createReadStream(file), {
        mime: 'video/mp4',
        name,
      })
      await expect(
        analyzeVideo(
          server.assets,
          'local',
          { assetId: source.id, kind: 'video' },
          settings,
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow(error)
    }
    const file = makeVideo(directory, [
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x48:r=2:d=1',
      '-c:v',
      'libx264',
    ])
    const source = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'source.mp4',
    })
    // Exercise the exact production budget branch with a small test budget, without writing a GiB.
    const budget = SHOT_ANALYSIS_LIMITS.outputBytes
    try {
      Object.defineProperty(SHOT_ANALYSIS_LIMITS, 'outputBytes', { value: 64 })
      await expect(
        analyzeVideo(
          server.assets,
          'local',
          { assetId: source.id, kind: 'video' },
          settings,
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow('1 GiB')
    } finally {
      Object.defineProperty(SHOT_ANALYSIS_LIMITS, 'outputBytes', { value: budget })
    }
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([])
  }, 30_000)

  it('损坏、超限和非法人工切点不发布结果，取消等待中的作业不会阻塞后续执行', async () => {
    const { server, dataDir } = await bootServer()
    const directory = tempDir()
    const bad = join(directory, 'bad.mp4')
    await writeFile(bad, 'invalid video')
    const broken = await server.assets.ingest('local', createReadStream(bad), {
      mime: 'video/mp4',
      name: 'broken.mp4',
    })
    await expect(
      analyzeVideo(
        server.assets,
        'local',
        { assetId: broken.id, kind: 'video' },
        settings,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow()
    const file = makeVideo(directory, [
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x48:r=2:d=1',
      '-c:v',
      'libx264',
    ])
    const source = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'good.mp4',
    })
    const ref = { assetId: source.id, kind: 'video' as const }
    await expect(
      analyzeVideo(
        server.assets,
        'local',
        ref,
        { ...settings, points: [0.8, 0.4] },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('切点')
    const originalGet = server.assets.get.bind(server.assets)
    const spy = vi.spyOn(server.assets, 'get').mockImplementation((owner, id) => {
      const asset = originalGet(owner, id)
      return asset ? { ...asset, size: 512 * 1024 * 1024 + 1 } : null
    })
    await expect(
      analyzeVideo(server.assets, 'local', ref, settings, new AbortController().signal, () => {}),
    ).rejects.toThrow('512 MiB')
    spy.mockRestore()
    const controller = new AbortController()
    let canceled = false
    await expect(
      analyzeVideo(server.assets, 'local', ref, settings, controller.signal, () => {
        if (!canceled) {
          canceled = true
          controller.abort(new Error('cancel requested'))
        }
      }),
    ).rejects.toThrow('cancel requested')
    expect(
      (
        await analyzeVideo(
          server.assets,
          'local',
          ref,
          settings,
          new AbortController().signal,
          () => {},
        )
      ).scenes,
    ).toHaveLength(1)
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([])
  }, 30_000)

  it('持久节点运行不调用模型，结果不写参数，重启与缓存保留manifest强引用', async () => {
    const first = await bootServer()
    const file = makeVideo(tempDir(), [
      '-f',
      'lavfi',
      '-i',
      'color=red:s=64x48:r=2:d=1',
      '-c:v',
      'libx264',
    ])
    const source = await first.server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'source.mp4',
    })
    const { id, doc } = await createCanvas(first.server)
    const { createElement } = await import('@plein/doc')
    const video = createElement(doc, {
      kind: 'video',
      assetId: source.id,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const node = addNode(doc, SHOT_ANALYSIS_TYPE)
    connect(doc, [video, 'video'], [node, 'video'])
    const submit = vi.spyOn(first.server.plugins, 'call')
    const run = first.server.runs.start(id, node, 'local')
    expect(await first.server.runs.wait(run)).toBe('succeeded')
    await until(() => !first.server.runs.isRunning(id, node))
    const result = currentResult(doc.get(node)!)!
    expect(result.value.type).toBe('json')
    expect(doc.get(node)!.params).not.toHaveProperty('manifest')
    expect(doc.get(node)!.params).not.toHaveProperty('scenes')
    const manifest = ShotAnalysisManifest.parse(
      result.value.type === 'json' ? result.value.value : null,
    )
    const refs = documentReferences(doc).filter((ref) => ref.nodeId === node)
    expect(refs.map((ref) => ref.assetId)).toContain(source.id)
    expect(refs.map((ref) => ref.assetId)).toContain(manifest.scenes[0]!.frame.assetId)
    expect(submit).not.toHaveBeenCalled()
    const inspection = await first.server.runs.inspect(
      doc,
      doc.get(node)!,
      'local',
      new AbortController().signal,
    )
    expect(first.server.runs.resultMatches(doc.get(node)!, inspection)).toBe(true)
    setParam(doc, node, 'cutPlan', { sourceAssetId: 'f'.repeat(64), points: [] })
    const mismatch = first.server.runs.start(id, node, 'local')
    expect(await first.server.runs.wait(mismatch)).toBe('failed')
    expect(doc.get(node)!.results).toHaveLength(1)
    await first.close()
    const second = await bootServer({ dataDir: first.dataDir })
    const { createDoc } = await import('@plein/doc')
    const restored = createDoc(second.server.rooms.get(id).doc)
    expect(
      documentReferences(restored)
        .filter((ref) => ref.nodeId === node)
        .map((ref) => ref.assetId),
    ).toContain(manifest.scenes[0]!.frame.assetId)
    restored.destroy()
  }, 30_000)
})
