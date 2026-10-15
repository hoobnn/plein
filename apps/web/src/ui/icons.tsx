import { createElement } from 'react'
import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  ArrowUpNarrowWide,
  AudioLines,
  Blend,
  Braces,
  Captions,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clapperboard,
  Copy,
  Download,
  FileOutput,
  FileText,
  Folder,
  Frame,
  Gauge,
  Grid3x3,
  GripVertical,
  Group,
  Hand,
  History,
  type IconNode,
  Image,
  ImagePlay,
  Images,
  Info,
  Keyboard,
  Languages,
  Layers,
  ListFilter,
  LayoutGrid,
  LayoutTemplate,
  LibraryBig,
  ListTodo,
  LocateFixed,
  Lock,
  LogOut,
  Map as MapIcon,
  Maximize2,
  Mic,
  Minimize2,
  Monitor,
  Moon,
  Mountain,
  MousePointer2,
  Music,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plug,
  SquareTerminal,
  Plus,
  Puzzle,
  Redo2,
  RotateCw,
  Search,
  Settings,
  Shirt,
  Smile,
  Sprout,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  SquareSplitHorizontal,
  Sparkles,
  Star,
  Spline,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Ungroup,
  Upload,
  UnfoldHorizontal,
  UserRound,
  Video,
  Volume2,
  VolumeOff,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide'

/**
 * 界面图标：Lucide 的 24 画板线框图标，按用途起名，只收录用到的。
 * 尺寸只用 12 / 14 / 16 / 20 / 24 五档（见 docs/dev/design-spec.md「图标」）；
 * 线宽随尺寸换算，12 → 1.25px、16 → 1.5px、20 以上 1.75px，小图标不糊、大图标不细。
 */
const ICONS = {
  // 工具与编辑
  cursor: MousePointer2,
  hand: Hand,
  undo: Undo2,
  redo: Redo2,
  retry: RotateCw,
  plus: Plus,
  x: X,
  check: Check,
  warning: TriangleAlert,
  pencil: Pencil,
  trash: Trash2,
  copy: Copy,
  group: Group,
  ungroup: Ungroup,
  arrange: Network,
  grip: GripVertical,
  search: Search,
  locate: LocateFixed,
  lock: Lock,
  filter: ListFilter,
  // 方向
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  collapseAll: ChevronsDownUp,
  expandAll: ChevronsUpDown,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  sortNewest: ArrowDownWideNarrow,
  sortOldest: ArrowUpNarrowWide,
  // 播放
  play: Play,
  pause: Pause,
  stop: Square,
  skipBack: SkipBack,
  skipForward: SkipForward,
  // 剪辑时间线
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fit: UnfoldHorizontal,
  captions: Captions,
  transition: Blend,
  speed: Gauge,
  exportFile: FileOutput,
  info: Info,
  // 元素与节点类型
  frame: Frame,
  doc: FileText,
  text: Type,
  image: Image,
  video: Video,
  audio: AudioLines,
  music: Music,
  mic: Mic,
  json: Braces,
  character: UserRound,
  // 角色档案：时期、服饰、表情
  period: Sprout,
  outfit: Shirt,
  expression: Smile,
  scene: Mountain,
  story: Clapperboard,
  sparkle: Sparkles,
  layers: Layers,
  library: LibraryBig,
  star: Star,
  // 视图与面板
  workflow: Workflow,
  board: LayoutGrid,
  map: MapIcon,
  edges: Spline,
  tasks: ListTodo,
  history: History,
  keyboard: Keyboard,
  upload: Upload,
  download: Download,
  expand: Maximize2,
  collapse: Minimize2,
  sidebarClose: PanelLeftClose,
  sidebarOpen: PanelLeftOpen,
  presets: LayoutTemplate,
  gridSplit: Grid3x3,
  sliders: SlidersHorizontal,
  // 视频生成模式与音频
  imageToVideo: ImagePlay,
  frames: SquareSplitHorizontal,
  references: Images,
  sound: Volume2,
  mute: VolumeOff,
  wand: WandSparkles,
  languages: Languages,
  // 设置与外观
  settings: Settings,
  palette: Palette,
  puzzle: Puzzle,
  plug: Plug,
  terminal: SquareTerminal,
  folder: Folder,
  logout: LogOut,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
} satisfies Record<string, IconNode>

export type IconName = keyof typeof ICONS
export type IconSize = 12 | 14 | 16 | 20 | 24

/** 实心画的图标：播放控制 */
const SOLID = new Set<IconName>(['play', 'pause', 'stop'])

/** 屏幕上的线宽（px）换算回 24 画板的 stroke-width */
const strokeWidth = (size: IconSize) => (Math.min(1.75, 0.5 + size / 16) * 24) / size

export function Icon({ name, size = 16 }: { name: IconName; size?: IconSize }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={SOLID.has(name) ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none"
    >
      {ICONS[name].map(([tag, props], i) => createElement(tag, { key: i, ...props }))}
    </svg>
  )
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 同一套图标的 DOM 版本：给不走 React 的画布覆盖层（节点卡片）用 */
export function iconElement(name: IconName, size: IconSize = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const attrs = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: SOLID.has(name) ? 'currentColor' : 'none',
    stroke: 'currentColor',
    'stroke-width': strokeWidth(size),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v))
  for (const [tag, props] of ICONS[name]) {
    const child = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(props))
      if (v !== undefined) child.setAttribute(k, String(v))
    svg.appendChild(child)
  }
  return svg
}
