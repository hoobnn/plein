import type { Engine } from '@plein/canvas-core'
import { currentResult, elementMedia } from '@plein/doc'
import type { Catalog, MediaCapsInfo } from '@plein/protocol'
import { useRef, useState } from 'react'
import {
  continueNodeFor,
  continueShot,
  playheadOf,
  type ContinuePoint,
} from '../../canvas/continueShot'
import { splitGrid } from '../../canvas/grid'
import { revealImports } from '../../canvas/import'
import { beginImport } from '../../canvas/importProgress'
import { importLocation, watchImportView } from '../../canvas/importView'
import { type MediaTarget, parseTimecode } from '../../canvas/media'
import { deriveNode, focusGenerator } from '../../canvas/presets'
import { startRegionEdit } from '../../canvas/regionEdit'
import {
  beginContinueRequest,
  continueRequestKey,
  useContinueRequest,
} from '../../features/generator/continueRequests'
import { MaskEditor } from '../../features/generator/MaskEditor'
import { useCanvas } from '../../stores/canvas'
import { creationScopeReason, mediaCreationCatalog } from './catalog'

export function useCreationTools(
  engine: Engine,
  targets: MediaTarget[],
  catalog: Catalog | null,
  close: () => void,
  caps?: MediaCapsInfo | null,
) {
  const first = targets[0]!
  const [masking, setMasking] = useState(false)
  const [at, setAt] = useState('')
  const canvasId = useCanvas((s) => s.canvasId)
  const scope = useRef({ engine, canvasId, sourceMap: engine.doc.elementMaps.get(first.elId) })
  const source = engine.doc.get(first.elId)
  const locked = targets.some((t) => engine.doc.get(t.elId)?.locked)
  const reason = creationScopeReason(targets, engine.doc.readOnly, locked)
  const tools = mediaCreationCatalog(catalog)
  const needsFrameTool = caps?.ffmpeg === false
  const playbackTime = first.kind === 'video' ? playheadOf(first.elId) : null
  const canUseTail =
    source?.kind === 'node' && currentResult(source, 'lastFrame')?.value.type === 'image'
  const key = continueRequestKey(engine, 'create', first.elId, first.assetId)
  const continuation = useContinueRequest(key)
  const notify = useCanvas.getState().notify
  const check = () => {
    const owner = useCanvas.getState()
    const current = engine.doc.get(first.elId)
    const error = creationScopeReason(
      targets,
      engine.doc.readOnly,
      targets.some((t) => engine.doc.get(t.elId)?.locked),
    )
    if (
      error ||
      owner.engine !== engine ||
      owner.canvasId !== scope.current.canvasId ||
      !current ||
      engine.doc.elementMaps.get(first.elId) !== scope.current.sourceMap ||
      elementMedia(current)?.assetId !== first.assetId
    ) {
      notify(error ?? '选定素材或画布已变化，请重新选择素材。')
      return false
    }
    return true
  }
  const draft = (
    type: string | undefined,
    params?: Record<string, unknown>,
    preset?: Catalog['prompts'][number],
  ) => {
    if (!check()) return
    if (!type) return notify('未找到所需节点，请刷新节点目录。')
    const id = deriveNode(engine, catalog, first.elId, type, {
      sourceAssetId: first.assetId,
      params,
      preset,
    })
    if (!id) return notify('所选素材不能连接到此工具，请重新选择素材。')
    close()
    notify('已创建并连接草稿。请核对参考、选择模型并手动生成；尚未调用生成平台。')
  }
  const grid = async (count: number) => {
    if (!check()) return
    close()
    const batch = beginImport(engine, count * count)
    const view = watchImportView(engine, batch.signal)
    const notes: string[] = []
    let action: ReturnType<typeof importLocation> | undefined
    try {
      const frame = await splitGrid(
        engine,
        first.elId,
        first.assetId,
        count,
        count,
        batch.progress,
        batch.signal,
      )
      if (frame && !batch.signal.aborted) {
        if (view.unchanged()) revealImports(engine, [frame])
        else {
          notes.push(`已完成 ${count * count} 个镜头切分`)
          action = importLocation(engine, [frame])
        }
      }
    } catch (error) {
      if (!batch.signal.aborted) notes.push((error as Error).message)
    } finally {
      view.dispose()
      batch.finish(notes, action)
    }
  }
  const runContinue = async (point: ContinuePoint) => {
    if (!check()) return
    const request = beginContinueRequest(engine, key)
    if (!request) return
    close()
    const view = watchImportView(engine, request.signal)
    try {
      const id = await continueShot(engine, catalog, first.elId, point, {
        signal: request.signal,
        focus: false,
      })
      if (!request.current() || request.signal.aborted) return
      if (view.unchanged()) {
        revealImports(engine, [id])
        focusGenerator(engine, id)
      }
      notify(
        '已取帧并创建续镜草稿，请核对模型和提示词后手动生成。',
        view.unchanged() ? undefined : importLocation(engine, [id]),
      )
    } catch (error) {
      if (request.current())
        notify(request.signal.aborted ? '已取消取帧' : (error as Error).message)
    } finally {
      view.dispose()
      request.finish()
    }
  }
  const note = (text: string) => <p className="ui-help px-2 pb-2">{text}</p>
  const button = (text: string, run: () => void, disabled = false, title?: string) => (
    <button
      type="button"
      className="ui-menu-item"
      disabled={!!reason || disabled}
      title={reason ?? title}
      onClick={run}
    >
      {text}
    </button>
  )
  const menu = (
    <>
      {reason && (
        <p role="status" className="ui-help px-2 py-2">
          {reason}
        </p>
      )}
      {first.kind === 'image' && (
        <>
          <section role="group" aria-label="图片结构与切分">
            <div className="ui-menu-label">图片结构 · 本地处理</div>
            {note('按已有宫格切成独立图片，保留原图；不会调用模型。')}
            {[2, 3, 4].map((n) => (
              <div key={n}>{button(`宫格切分 · ${n * n} 宫格`, () => void grid(n))}</div>
            ))}
          </section>
          <section role="group" aria-label="AI 能力">
            <div className="ui-menu-label">AI 能力 · 创建草稿</div>
            {note('先创建并连接参考，再在节点选择模型、补充要求并手动生成。')}
            {button(
              'AI 精修（放大 / 扩图 / 抠图）',
              () => draft(tools.process?.type),
              !tools.process,
            )}
            {!tools.process && note('缺少图片精修节点，请刷新节点目录。')}
            {(['upscale', 'outpaint', 'cutout'] as const).map((op) => (
              <div key={op}>
                {button(
                  { upscale: 'AI 高清放大', outpaint: 'AI 扩图', cutout: '主体抠图（透明图层）' }[
                    op
                  ],
                  () => draft(tools.process?.type, { operation: op }),
                  !tools.process || !tools.supportsProcess(op),
                )}
                {!tools.supportsProcess(op) &&
                  note('未启用声明支持此操作的模型；可先创建图片精修草稿，再配置模型。')}
              </div>
            ))}
            {button(
              '局部重绘 · 先画区域',
              () => {
                if (check()) {
                  close()
                  setMasking(true)
                }
              },
              !tools.edit,
            )}
            {!tools.edit && note('缺少局部重绘节点，请刷新节点目录。')}
            {!tools.hasEditModel && note('局部重绘尚无已启用模型，绘制区域后仍需配置并选择模型。')}
            {button(
              '生成视频 · 首帧草稿',
              () => draft(tools.video?.type, { mode: 'image' }),
              !tools.video,
            )}
            {!tools.video && note('缺少可接受图片参考的视频节点，请刷新节点目录。')}
            {!tools.hasVideoModel && note('尚无已启用的视频模型，草稿不会自动生成。')}
          </section>
          <section role="group" aria-label="提示词配方">
            <div className="ui-menu-label">提示词配方 · 创建草稿</div>
            {note('三视图、九宫格等通过提示词引导模型；需要生成后检查人物与构图。')}
            {tools.recipes.map((recipe) => (
              <div key={recipe.id}>
                {button(recipe.title, () => draft(tools.image?.type, undefined, recipe))}
              </div>
            ))}
            {!tools.recipes.length && note('当前节点目录没有适用的图片配方。')}
            {!tools.hasImageModel && note('尚无已启用的图片生成模型；可先建草稿，再配置模型。')}
          </section>
        </>
      )}
      {first.kind === 'video' && (
        <section role="group" aria-label="视频创作">
          <div className="ui-menu-label">视频创作 · 取帧后创建草稿</div>
          {note('续镜先在本地抽帧，再创建视频草稿，不会自动提交视频生成。')}
          {button(
            '从尾帧续镜',
            () => void runContinue({ last: true }),
            !source ||
              !continueNodeFor(catalog, source) ||
              !!continuation.pending ||
              (needsFrameTool && !canUseTail),
          )}
          {button(
            '从当前播放位置续镜',
            () => {
              const time = playheadOf(first.elId)
              if (time === null) notify('未读取到视频播放位置，请使用指定时间续镜。')
              else void runContinue({ at: time })
            },
            !source ||
              !continueNodeFor(catalog, source) ||
              !!continuation.pending ||
              needsFrameTool ||
              playbackTime === null,
          )}
          <label className="ui-field px-2">
            <span className="ui-label">续镜时间（秒或时间码）</span>
            <input
              className="ui-input"
              aria-label="续镜时间"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          {button(
            '从指定时间续镜',
            () => {
              const time = parseTimecode(at)
              if (time === null) notify('请输入有效时间，例如 1.5 或 0:02。')
              else void runContinue({ at: time })
            },
            !source ||
              !continueNodeFor(catalog, source) ||
              !!continuation.pending ||
              needsFrameTool,
          )}
          {!tools.hasVideoModel &&
            note('当前没有已启用的视频模型；可以先创建续镜草稿，再配置模型。')}
          {playbackTime === null && note('未读取到当前播放位置，可输入指定时间续镜。')}
          {needsFrameTool &&
            note('本机未提供 ffmpeg，不能抽取新画面；已有视频返回尾帧时仍可直接接续。')}
          {(!source || !continueNodeFor(catalog, source)) &&
            note('当前目录缺少可接受首帧的视频节点，请先配置相关节点。')}
        </section>
      )}
      {first.kind === 'audio' && (
        <section role="group" aria-label="音频工具范围">
          <div className="ui-menu-label">音频创作</div>
          {note('此处提供截取、变速和手动切分。声音设计、复刻与角色音色在资产库的音色页管理。')}
        </section>
      )}
    </>
  )
  return {
    menu,
    check,
    trigger: continuation.trigger,
    pending: continuation.pending,
    cancel: continuation.cancel,
    overlay: masking && (
      <MaskEditor
        assetId={first.assetId}
        name={source?.name ?? '图片'}
        onClose={() => setMasking(false)}
        onSave={(mask) => {
          setMasking(false)
          if (!check()) return
          const id = startRegionEdit(engine, catalog, first.elId, mask, source?.name ?? '图片')
          if (id) notify('已创建局部重绘草稿，请补充修改要求、选择模型并手动生成。')
        }}
      />
    ),
  }
}
