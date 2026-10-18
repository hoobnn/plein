import { type Engine, NODE_LAYOUT } from '@plein/canvas-core'
import { type CanvasElement, currentResult, type Rect, type RunStatus } from '@plein/doc'
import { useCanvas } from '../stores/canvas'
import {
  ANIMATIC_TYPE,
  SEQUENCE_TYPE,
  ASSET_NODE_TYPES,
  presetsFor,
  profileEmpty,
  profileOf,
  profileSize,
  STAGE_TYPE,
  STORYBOARD_TYPE,
  type MentionTarget,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useCatalog } from '../stores/catalog'
import { type StaleKind, useStale } from '../features/runs/stale'
import { type IconName, iconElement } from '../ui/icons'
import { findNode, isPure, promptKey, targetImages, mentionTargets } from './nodes'
import { renderMentionText } from './mentionText'
import {
  clock,
  describeActive,
  describeFailure,
  openProviderSettings,
  RUN_STEPS,
} from './runStatus'
import { shotsOf } from '../features/storyboard/model'
import { clipOverlay } from './occlusion'
import { cancelRequestKey, useCancelRequests } from '../features/runs/cancelRequests'
import { runRequestKey, useRunRequests } from '../features/runs/runRequests'

type PromptPreset = Catalog['prompts'][number]

export interface NodeCardActions {
  canvasId: string | null
  play(id: string): void
  run(id: string): void
  cancel(id: string, runId?: string): void
  /** 空节点上的“尝试”：套用提示词预设并聚焦生成器 */
  applyPreset(id: string, preset: PromptPreset): void
  /** 资产卡上参考图缩略图的地址 */
  thumbUrl(assetId: string): string
}

interface Card {
  root: HTMLDivElement
  glyph: HTMLSpanElement
  title: HTMLSpanElement
  status: HTMLSpanElement
  nav: HTMLSpanElement
  count: HTMLSpanElement
  body: HTMLDivElement
  progress: HTMLDivElement
  /** 运行中浮层：建一次，之后只改文字，转圈和步骤的动画不会被打断 */
  live?: LiveBox
  /** 上次渲染的签名，没变化就不碰 DOM */
  sig: string
}

interface LiveBox {
  nodeId: string
  cancel: HTMLButtonElement
  box: HTMLDivElement
  label: HTMLSpanElement
  detail: HTMLSpanElement
  steps: HTMLOListElement
  time: HTMLSpanElement
}

const STATUS_TEXT: Record<RunStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '',
  failed: '失败',
  canceled: '已取消',
}

/** 结果过期时卡片上的状态与悬停说明 */
const STALE_TEXT: Record<StaleKind, string> = {
  self: '需要重跑',
  upstream: '上游已改',
  kept: '已保留',
}
const STALE_HINT: Record<StaleKind, string> = {
  self: '参数或输入改过，当前结果不是按现在的设置生成的',
  upstream: '上游节点改过，重跑上游后这里也要重跑',
  kept: '结果已过期，你在「查看影响」里确认过先保留',
}

/** 按输出类型的图标，标题前和空节点中央用 */
const GLYPHS: Record<string, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  text: 'text',
  json: 'json',
}

/** 卡片上的按钮：图标按钮传 icon，文字按钮传 text */
function button(cls: string, label: string, content: { text: string } | { icon: IconName }) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.title = label
  b.setAttribute('aria-label', label)
  if ('icon' in content) b.appendChild(iconElement(content.icon, 14))
  else b.textContent = content.text
  return b
}

/** 资产卡按类别区分图标，与资产库的分类一致 */
const CARD_GLYPHS: Record<string, IconName> = {
  'plein/scene': 'scene',
  'plein/prop': 'puzzle',
  'plein/style': 'palette',
  'plein/effect': 'wand',
}

function glyphOf(el: CanvasElement, kind: string): IconName {
  if (el.nodeType === STORYBOARD_TYPE) return 'story'
  if (el.nodeType === STAGE_TYPE) return 'cube'
  if (el.nodeType && ASSET_NODE_TYPES.has(el.nodeType))
    return CARD_GLYPHS[el.nodeType] ?? 'character'
  return GLYPHS[kind] ?? 'text'
}

/**
 * 节点卡片的 DOM 层（正常细节下）：
 * - 标题行在卡片外上方：类型图标、名称，右侧是状态和候选切换；
 * - 卡片本体就是结果（图片 / 视频封面由 GPU 画，这里透明），没有结果时显示类型图标和“尝试”预设；
 * - 生成中在卡片中央显示进度和取消，失败显示原因和重试。
 * 卡片本身不接收指针事件（拖动、选择照常交给画布），只有按钮可点。
 */
export class NodeCards {
  private mentions: MentionTarget[] = []
  private mentionKey = ''
  private cards = new Map<string, Card>()
  private viewport: Rect | undefined
  private disposers: Array<() => void> = []
  /** 有节点在运行时每秒走一次：已用时长、重试倒计时 */
  private ticker: ReturnType<typeof setInterval> | undefined

  constructor(
    private engine: Engine,
    private root: HTMLElement,
    private actions: NodeCardActions,
  ) {
    this.disposers.push(
      // 只是平移出入视口：已有的卡片不动，只增删
      engine.onViewChange(({ content }) => this.sync(content)),
      engine.onMove(() => {
        const next = engine.camera.viewRect
        const prev = this.viewport
        if (
          !prev ||
          next.x !== prev.x ||
          next.y !== prev.y ||
          next.w !== prev.w ||
          next.h !== prev.h
        )
          this.sync(false)
      }),
      engine.selection.onChange(() => this.sync()),
      useCatalog.subscribe(() => {
        for (const c of this.cards.values()) c.sig = ''
        this.sync()
      }),
      useStale.subscribe(() => this.sync()),
      useCancelRequests.subscribe(() => this.tick()),
      useRunRequests.subscribe(() => this.sync()),
    )
    this.sync()
  }

  sync(content = true) {
    const { engine } = this
    const viewport = engine.camera.viewRect
    this.viewport = viewport
    if (content) {
      this.mentions = mentionTargets(engine)
      this.mentionKey = JSON.stringify(this.mentions)
    }
    const want = new Set<string>()
    if (engine.highDetail) {
      for (const id of engine.visibleIds) {
        if (engine.scene.get(id)?.kind === 'node') want.add(id)
      }
    }
    for (const [id, c] of this.cards) {
      if (!want.has(id)) {
        c.root.remove()
        this.cards.delete(id)
      }
    }
    for (const id of want) {
      const el = engine.scene.get(id)!
      const rect = engine.scene.rect(id)
      if (!rect) continue
      let card = this.cards.get(id)
      if (card && !content) {
        clipOverlay(card.root, engine.scene, id, rect, NODE_LAYOUT.title, viewport)
        continue
      }
      if (!card) {
        card = this.create(id)
        this.cards.set(id, card)
      }
      card.root.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      card.root.style.width = `${rect.w}px`
      card.root.style.height = `${rect.h}px`
      this.render(card, { ...el, ...rect }, engine.selection.has(id))
      clipOverlay(card.root, engine.scene, id, rect, NODE_LAYOUT.title, viewport)
    }
    const ticking = [...this.cards.values()].some((c) => c.live)
    if (ticking && !this.ticker) this.ticker = setInterval(() => this.tick(), 1000)
    else if (!ticking && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = undefined
    }
  }

  /** 只刷新运行中卡片的时间和文字，不重建 DOM */
  private tick() {
    for (const [id, card] of this.cards) {
      const run = this.engine.scene.get(id)?.run
      if (!run || !card.live) continue
      this.updateLive(card, run)
    }
  }

  destroy() {
    clearInterval(this.ticker)
    for (const d of this.disposers) d()
    for (const c of this.cards.values()) c.root.remove()
    this.cards.clear()
  }

  private create(id: string): Card {
    const root = document.createElement('div')
    root.className = 'plein-node'
    root.style.setProperty('--node-title', `${NODE_LAYOUT.title}px`)

    const head = document.createElement('div')
    head.className = 'plein-node-head'
    const glyph = document.createElement('span')
    glyph.className = 'plein-node-glyph'
    const title = document.createElement('span')
    title.className = 'plein-node-title'
    const status = document.createElement('span')
    status.className = 'plein-node-status'
    const nav = document.createElement('span')
    nav.className = 'plein-node-nav'
    const prev = button('plein-node-btn', '上一个结果', { icon: 'chevronLeft' })
    const count = document.createElement('span')
    count.className = 'plein-node-count'
    const next = button('plein-node-btn', '下一个结果', { icon: 'chevronRight' })
    nav.append(prev, count, next)
    head.append(glyph, title, status, nav)

    const body = document.createElement('div')
    body.className = 'plein-node-body'
    const progress = document.createElement('div')
    progress.className = 'plein-node-progress'

    root.append(head, body, progress)
    this.root.appendChild(root)

    const step = (d: number) => {
      const el = this.engine.scene.get(id)
      if (!el) return
      const list = primaryResults(el)
      const cur = currentResult(el, list[0]?.port)
      const i = list.findIndex((r) => r.id === cur?.id)
      const target = list[(i + d + list.length) % list.length]
      if (target)
        useCanvas
          .getState()
          .view({ kind: 'result', nodeId: id, resultId: target.id, name: el.name ?? '候选审片' })
    }
    prev.addEventListener('click', () => step(-1))
    next.addEventListener('click', () => step(1))

    return { root, glyph, title, status, nav, count, body, progress, sig: '' }
  }

  private render(card: Card, el: CanvasElement, selected: boolean) {
    const catalog = useCatalog.getState().catalog
    const info = findNode(catalog, el.nodeType)
    const pure = info ? isPure(info) : false
    const pk = info ? promptKey(info) : undefined
    const key = pure ? pk : undefined
    const thumbs =
      el.nodeType && ASSET_NODE_TYPES.has(el.nodeType) ? targetImages(this.engine, el) : []
    const board = el.nodeType === STORYBOARD_TYPE
    const sig = JSON.stringify([
      thumbs,
      el.w,
      el.h,
      el.name,
      el.run,
      useRunRequests.getState().pending.has(runRequestKey(this.actions.canvasId, el.id)),
      useStale.getState().nodes.get(el.id),
      el.adopted,
      el.results?.length,
      el.results?.[0]?.id,
      pk ? el.params?.[pk] : undefined,
      selected,
      Boolean(info),
      board ? el.params?.shots : undefined,
      el.params?.profile,
      key || info?.outputs[0]?.type === 'text' || ASSET_NODE_TYPES.has(el.nodeType ?? '')
        ? this.mentionKey
        : undefined,
    ])
    if (sig === card.sig) return
    card.sig = sig

    const run = el.run
    const active = run?.status === 'running' || run?.status === 'queued'
    const kind = info?.outputs[0]?.type ?? ''
    card.root.dataset.status = run?.status ?? 'idle'
    card.root.dataset.kind = kind
    card.root.dataset.selected = String(selected)
    card.title.textContent = el.name ?? info?.title ?? el.nodeType ?? '节点'
    card.glyph.replaceChildren(iconElement(glyphOf(el, kind), 14))

    let status = run ? STATUS_TEXT[run.status] : ''
    // 任务历史保留取消事实；画布已明确采用该任务取回的结果时展示当前可用状态。
    if (run?.status === 'canceled' && currentResult(el)?.runId === run.id) status = '已取回'
    if (run && active) {
      const view = describeActive(run, Date.now())
      status = view.retrying ? '重试中' : view.label
    }
    // 参数或上游改过、结果已经过期：运行中、失败时以运行状态为准
    const stale =
      active || run?.status === 'failed' ? undefined : useStale.getState().nodes.get(el.id)
    if (stale) status = STALE_TEXT[stale]
    card.root.dataset.stale = stale ?? ''
    card.status.title = stale ? STALE_HINT[stale] : ''
    card.status.textContent = status
    // 不知道进度时进度条换成来回流动的光，一眼能看出没卡住
    const known = active && run?.status === 'running' && run.phase !== 'retrying' && !!run.progress
    card.progress.classList.toggle('is-indeterminate', active && !known)
    card.progress.style.width = known ? `${Math.max(4, run!.progress! * 100)}%` : active ? '' : '0'

    const list = primaryResults(el)
    const cur = currentResult(el, list[0]?.port)
    const v = cur?.value
    card.nav.hidden = list.length < 2
    card.count.textContent = `${list.findIndex((r) => r.id === cur?.id) + 1}/${list.length}`

    const editHint =
      el.nodeType === SEQUENCE_TYPE
        ? '双击编辑序列'
        : el.nodeType === ANIMATIC_TYPE
          ? '双击编辑节奏样片'
          : undefined
    card.root.title = editHint ?? ''
    card.body.className = 'plein-node-body'
    if (!info) {
      card.body.textContent = `未安装的节点类型：${el.nodeType ?? '未知'}`
      card.body.classList.add('is-hint')
    } else if (thumbs.length || (el.nodeType && ASSET_NODE_TYPES.has(el.nodeType))) {
      // 资产卡：参考图一字排开，下面是设定
      const strip = document.createElement('div')
      strip.className = 'plein-node-thumbs'
      for (const id of thumbs.slice(0, 4)) {
        const img = document.createElement('img')
        img.src = this.actions.thumbUrl(id)
        img.alt = ''
        strip.appendChild(img)
      }
      if (!thumbs.length) strip.textContent = '从左侧连入 2–4 张多角度参考图'
      const text = document.createElement('div')
      renderMentionText(
        text,
        String(el.params?.description ?? '') || '在下方写设定',
        this.mentions.filter((t) => t.id !== el.id),
        (id) => {
          this.engine.selection.set([id])
          this.engine.zoomToFit([id])
        },
      )
      text.className = el.params?.description ? '' : 'plein-node-muted'
      card.body.replaceChildren(strip, ...profileRow(el), text)
      card.body.classList.add('is-text')
    } else if (board && !active && shotsOf(el).length) {
      // 分镜：镜号 / 景别 / 画面的小表，双击打开完整表格
      const shots = shotsOf(el)
      const ol = document.createElement('ol')
      ol.className = 'plein-node-shots'
      for (const s of shots.slice(0, 12)) {
        const li = document.createElement('li')
        const no = document.createElement('span')
        no.textContent = String(s.no).padStart(2, '0')
        const size = document.createElement('span')
        size.textContent = s.shotSize
        const desc = document.createElement('span')
        desc.textContent = s.description
        li.append(no, size, desc)
        ol.appendChild(li)
      }
      const more = document.createElement('div')
      more.className = 'plein-node-muted'
      more.textContent = `${shots.length} 个镜头 · ${shots.reduce((t, s) => t + s.duration, 0)} 秒 · 双击打开分镜表`
      card.body.replaceChildren(ol, more)
      card.body.classList.add('is-text')
    } else if (key) {
      const text = String(el.params?.[key] ?? '')
      renderMentionText(
        card.body,
        text || '双击写下文本，连到下游节点',
        this.mentions.filter((t) => t.id !== el.id),
        (id) => {
          this.engine.selection.set([id])
          this.engine.zoomToFit([id])
        },
      )
      card.body.classList.add('is-text')
      card.body.classList.toggle('is-hint', !text)
    } else if (active) {
      this.renderRunning(card, el)
    } else if (run?.status === 'failed') {
      this.renderFailed(card, el, run)
    } else if (v?.type === 'text') {
      renderMentionText(
        card.body,
        v.text,
        this.mentions.filter((t) => t.id !== el.id),
        (id) => {
          this.engine.selection.set([id])
          this.engine.zoomToFit([id])
        },
      )
      card.body.classList.add('is-text')
    } else if (v?.type === 'json') {
      card.body.textContent = JSON.stringify(v.value, null, 2)
      card.body.classList.add('is-text')
    } else if (v) {
      // 图片、视频封面、音频波形由 GPU 画；视频右下角标一个播放提示
      card.body.replaceChildren()
      if (v.type === 'video') {
        const tag = document.createElement('span')
        tag.className = 'ui-badge'
        tag.append(iconElement('play', 12), editHint ?? '双击播放')
        card.body.appendChild(tag)
        if (editHint) {
          const label = el.nodeType === SEQUENCE_TYPE ? '播放成片' : '播放样片'
          const play = button('plein-node-action ui-badge', label, { text: label })
          play.prepend(iconElement('play', 14))
          // 独立控件不进入画布的节点激活、选择或拖动路径。
          for (const event of ['pointerdown', 'pointerup', 'dblclick'])
            play.addEventListener(event, (e) => e.stopPropagation())
          play.addEventListener('click', (e) => {
            e.stopPropagation()
            this.actions.play(el.id)
          })
          card.body.appendChild(play)
        }
      }
      card.body.classList.add('is-media')
    } else {
      // 已经写了提示词就不再推荐预设
      const written = pk ? String(el.params?.[pk] ?? '').trim() : ''
      this.renderEmpty(card, el, kind, written ? [] : presetsFor(catalog?.prompts ?? [], info))
    }
    // 运行浮层只在运行中保留，其他状态清掉引用，下次运行重新建
    if (!card.body.classList.contains('is-running')) card.live = undefined
  }

  /** 空节点：中央类型图标，下面列几个可直接套用的预设 */
  private renderEmpty(card: Card, el: CanvasElement, kind: string, presets: PromptPreset[]) {
    const center = document.createElement('div')
    center.className = 'plein-node-empty'
    const icon = document.createElement('span')
    icon.className = 'plein-node-empty-icon'
    icon.appendChild(iconElement(glyphOf(el, kind), 24))
    center.appendChild(icon)
    if (el.nodeType === SEQUENCE_TYPE || el.nodeType === ANIMATIC_TYPE) {
      const hint = document.createElement('span')
      hint.className = 'plein-node-muted'
      hint.textContent = el.nodeType === SEQUENCE_TYPE ? '双击编辑序列' : '双击编辑节奏样片'
      center.appendChild(hint)
    }
    if (el.nodeType === STAGE_TYPE) {
      const hint = document.createElement('span')
      hint.className = 'plein-node-muted'
      hint.textContent = '双击摆人物和机位，截一张构图'
      center.appendChild(hint)
    }
    const room = el.h >= 150 && el.w >= 160
    if (room && presets.length) {
      const tries = document.createElement('div')
      tries.className = 'plein-node-tries'
      const label = document.createElement('span')
      label.className = 'plein-node-tries-label'
      label.textContent = '试试'
      tries.appendChild(label)
      for (const p of presets.slice(0, el.h >= 220 ? 3 : 2)) {
        const b = button('plein-node-try', p.description ?? p.title, { text: p.title })
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          this.actions.applyPreset(el.id, p)
        })
        tries.appendChild(b)
      }
      center.appendChild(tries)
    }
    card.body.replaceChildren(center)
    card.body.classList.add('is-empty')
  }

  /**
   * 运行中：转圈、当前在做什么（平台排队、生成 42%、3 秒后重试）、调用的平台、
   * 四步进度（提交 → 排队 → 生成 → 保存）、已用时长和取消。
   */
  private renderRunning(card: Card, el: CanvasElement) {
    card.body.classList.add('is-running')
    if (!card.live || card.live.box.parentNode !== card.body) {
      const box = document.createElement('div')
      box.className = 'plein-node-running'
      const spin = document.createElement('span')
      spin.className = 'ui-spinner'
      const label = document.createElement('span')
      label.className = 'plein-node-run-label'
      const detail = document.createElement('span')
      detail.className = 'plein-node-run-detail'
      const steps = document.createElement('ol')
      steps.className = 'plein-node-steps'
      for (const name of RUN_STEPS) {
        const li = document.createElement('li')
        li.title = name
        steps.appendChild(li)
      }
      const foot = document.createElement('span')
      foot.className = 'plein-node-run-foot'
      const time = document.createElement('span')
      time.className = 'plein-node-run-time'
      const cancel = button('plein-node-action', '取消生成', { text: '取消' })
      cancel.addEventListener('click', (e) => {
        e.stopPropagation()
        this.actions.cancel(el.id, cancel.dataset.runId)
      })
      foot.append(time, cancel)
      box.append(spin, label, detail, steps, foot)
      card.body.replaceChildren(box)
      card.live = { box, label, detail, steps, time, cancel, nodeId: el.id }
    }
    // 卡片太矮时只留转圈、标签和取消
    card.live.box.dataset.compact = String(el.h < 150 || el.w < 160)
    if (el.run) this.updateLive(card, el.run)
  }

  private updateLive(card: Card, run: NonNullable<CanvasElement['run']>) {
    const live = card.live!
    const view = describeActive(run, Date.now())
    const canceling = useCancelRequests
      .getState()
      .pending.has(cancelRequestKey(this.actions.canvasId, live.nodeId, run.id))
    live.cancel.dataset.runId = run.id
    live.cancel.disabled = canceling
    live.cancel.setAttribute('aria-busy', String(canceling))
    live.cancel.textContent = canceling ? '正在停止…' : '取消'
    live.cancel.title = canceling ? '正在停止任务…' : '取消生成'
    live.box.dataset.phase = run.status === 'queued' ? 'local' : (run.phase ?? 'generating')
    const label = canceling ? '正在停止任务…' : view.label
    if (live.label.textContent !== label) live.label.textContent = label
    const detail = view.detail ?? ''
    if (live.detail.textContent !== detail) {
      live.detail.textContent = detail
      live.detail.title = detail
    }
    live.steps.hidden = view.step === undefined
    live.steps.childNodes.forEach((li, i) => {
      const state =
        view.step === undefined ? '' : i < view.step ? 'done' : i === view.step ? 'now' : ''
      ;(li as HTMLElement).dataset.state = state
    })
    const time = [
      view.elapsed !== undefined && clock(view.elapsed),
      run.attempt && run.attempt > 1 && `第 ${run.attempt} 次`,
    ]
      .filter(Boolean)
      .join(' · ')
    if (live.time.textContent !== time) live.time.textContent = time
  }

  /** 失败：一句人话的原因，平台原话在下面；密钥、余额问题给“去设置” */
  private renderFailed(card: Card, el: CanvasElement, run: NonNullable<CanvasElement['run']>) {
    const submitting = useRunRequests
      .getState()
      .pending.has(runRequestKey(this.actions.canvasId, el.id))
    const view = describeFailure(run)
    const box = document.createElement('div')
    box.className = 'plein-node-failed'
    const icon = document.createElement('span')
    icon.className = 'plein-node-failed-icon'
    icon.appendChild(iconElement('warning', 16))
    const title = document.createElement('strong')
    title.textContent = view.title
    box.append(icon, title)
    if (view.detail) {
      const detail = document.createElement('span')
      detail.textContent = view.detail
      detail.title = view.detail
      box.appendChild(detail)
    }
    const actions = document.createElement('span')
    actions.className = 'plein-node-failed-actions'
    const retry = button('plein-node-action', '重试', { text: '重试' })
    retry.disabled = submitting
    retry.setAttribute('aria-busy', String(submitting))
    if (submitting) {
      retry.textContent = '正在提交…'
      const waiting = document.createElement('span')
      waiting.className = 'plein-node-muted'
      waiting.setAttribute('role', 'status')
      waiting.textContent = '正在提交重试…'
      box.appendChild(waiting)
    }
    retry.addEventListener('click', (e) => {
      e.stopPropagation()
      this.engine.selection.set([el.id])
      this.actions.run(el.id)
    })
    actions.appendChild(retry)
    if (view.settings) {
      const fix = button('plein-node-action', '打开模型平台设置', { text: '去设置' })
      fix.addEventListener('click', (e) => {
        e.stopPropagation()
        openProviderSettings()
      })
      actions.appendChild(fix)
    }
    box.appendChild(actions)
    card.body.replaceChildren(box)
    card.body.classList.add('is-failed')
  }
}

/** 主输出端口的结果（卡片只展示和切换它） */
function primaryResults(el: CanvasElement) {
  const port = el.ports?.outputs[0]?.id
  return (el.results ?? []).filter((r) => port === undefined || r.port === port)
}

/** 角色卡的档案行：时期名一排小标签，后面是服饰和表情的数量 */
function profileRow(el: CanvasElement): HTMLElement[] {
  if (el.nodeType !== 'plein/character') return []
  const profile = profileOf(el.params?.profile)
  if (profileEmpty(profile)) return []
  const row = document.createElement('div')
  row.className = 'plein-node-profile'
  for (const p of profile.periods.slice(0, 4)) {
    const chip = document.createElement('span')
    chip.className = 'plein-node-chip'
    chip.append(iconElement('period', 12), p.name)
    row.appendChild(chip)
  }
  const size = profileSize(profile)
  const rest = [
    size.outfits && `${size.outfits} 服饰`,
    size.expressions && `${size.expressions} 表情`,
  ].filter(Boolean)
  if (rest.length) {
    const meta = document.createElement('span')
    meta.className = 'plein-node-muted'
    meta.textContent = rest.join(' · ')
    row.appendChild(meta)
  }
  return [row]
}
