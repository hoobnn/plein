# 界面设计规范

原则：外壳克制、尺寸成体系、层级靠材质和阴影区分，颜色留给画布里的作品。通用控件的视觉以 shadcn/ui Nova（Base UI）为基准。所有数值都是 `apps/web/src/styles/tokens.css` 里的令牌或 Tailwind 的令牌化阶梯，组件只用这些工具类和仍需保留的通用控件类，不写任意值（`rounded-[10px]`、`text-[13px]`、`!h-9` 这类）。

## 配色

- 外壳只用灰阶。`primary` 是黑白反色的主操作（生成、新建、确认）。
- `accent` 是蓝，只表示选中、焦点、链接和运行中。
- 端口和元素类型各有一个颜色（文本、图片、视频、音频、JSON），只用在类型图标、端口和连线上；剪辑时间线借这套色板区分轨道（画面、对白、音效、配乐、字幕，见 `styles/sequence.css`）。
- 明暗两套颜色由 `<html data-theme>` 切换，画布 GPU 层的颜色在 `packages/canvas-core/src/theme.ts`，两边数值对应。
- `ink-subtle` 仍是可读信息：在 `canvas`、`surface`、`surface-2`、`surface-3` 上的文字对比度至少 4.5:1；禁用状态单独使用透明度，不把说明文字当作禁用文字处理。GPU 元素名称与 `ink-muted` 对齐。
- 连线保留来源的数据类型色：内容输入用实线，接入 `references` 的参考素材用细虚线。选中或悬停节点时突出关联线并显示下游方向；选中时弱化其他线，运行时使用流动虚线。视图工具栏的「图例」解释颜色和线型，不能只靠颜色传递关系。
- 分镜编辑按镜头分卡，上方固定镜号、时长、景别和状态；正文分为镜头内容与生成提示词，面板内容宽度不足 900px 时切换单列。长文本保留可读宽度，高度设上限后内部滚动；批量操作独立于标题栏，关闭按钮始终可达。

- 节点生成器优先分配空间给提示词，正文保持 14 / 22 的字号与行高。参考素材用 48px 缩略图，编号放在图旁；引用和警告保持单行，长名称截断后可悬停查看全文，数量多时横向滚动。「镜头与风格」和「实际输入」收起时共用一行，展开时各占整行；底部模型、参数和生成按钮统一为 32px 高。

## 间距

以 4px 为基线，使用 2 的倍数：2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 32 · 40 · 48 · 64。Tailwind 的 `--spacing` 固定为 4px，`p-3` 就是 12，Nova 常用的 `p-2.5` 就是 10，不随根字号变化。

| 场景                           | 值                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 浮动外框离视口边               | 12（`--chrome-inset`）                                                                               |
| 浮层之间、工具条离所贴元素     | 旧工具条 8；Nova Select / Popover / MenuSelect 为 4                                                  |
| 工具条、菜单的内边距           | 4；Nova 弹层内容用 10（`p-2.5`）                                                                     |
| 字段内部（标签、控件、说明）   | 6（`--field-gap`）                                                                                   |
| 字段之间                       | 紧凑表单 12 / 普通表单 16                                                                            |
| 面板内边距                     | 紧凑侧栏 12（`--panel-pad-sm`）/ 普通面板 16（`--panel-pad`）/ 大型工作对话框 20（`--panel-pad-lg`） |
| 确认 / 输入对话框内边距        | Nova 统一 16；项目打包对话框暂保留桌面 24 / 窄屏 20                                                  |
| 分区之间                       | 24                                                                                                   |
| 首页栏宽 / 网格间距 / 区块间距 | 1008 / 16 / 32                                                                                       |

字段、面板内边距和行高这几个反复出现的语义值有令牌（`--field-gap`、`--panel-pad-*`、`--leading-*`）；其余间距直接用 `--spacing` 的数值阶梯，不为单个 gap 另造变量。

## 面板、菜单、对话框与断点

浮层的宽度成档，不再按组件各写各的。JS 侧的同值常量在 `ui/layout.ts`，`ui/layout.test.ts` 会和 `tokens.css` 对比。

| 类别                   | 令牌                                | 值                        | 用在                                                |
| ---------------------- | ----------------------------------- | ------------------------- | --------------------------------------------------- |
| 右侧面板               | `--panel-w-sm / md / lg`            | 320 / 360 / 400           | 更新提醒 / 任务、创作引导 / 助手                    |
| 菜单、选择器           | `--menu-w-sm / md / lg`，`--menu-h` | 220 / 240 / 280，最高 440 | 紧凑菜单 / 添加菜单和选择器 / 宽菜单                |
| 弹层最高               | `--pop-max-h`                       | 480                       | Popover、下拉                                       |
| 对话框（`Modal size`） | `--dialog-w-sm / md / lg / xl`      | 640 / 880 / 1120 / 1440   | 确认和小表单 / 单栏内容 / 双栏工作面板 / 分镜、序列 |
| 对话框高度             | `--dialog-h`                        | `min(850px, 100%)`        | 资料库、设置、检查点等内容多的面板（`Modal tall`）  |
| 小控件                 | `--h-2xs`                           | 20                        | 键帽、标签、徽标、移除按钮、加载圈                  |
| 胶囊                   | `--radius-pill`                     | 9999                      | 芯片、徽标、滑块，不再写 999px                      |

- 右侧面板占掉的画布宽度是面板宽度加 `--chrome-inset`（助手 412、任务 372）。编辑器相机内缩和首页让位都读同一份常量，改面板宽度只改令牌与 `layout.ts`。
- 900 以下右侧面板铺满视口宽度（左右各留 `--chrome-inset`），相机不再内缩，避免面板盖住画布而相机不知情。
- 对话框用 `Modal size` 选档，不写 `max-w-*`；尺寸由 `.ui-dialog[data-size]` 提供，宽度始终不超过视口减去外层边距（16 / 24）。同档同高的面板顶边、标题行高度和关闭按钮位置一致。

断点只有四档，Tailwind 前缀直接可用，没有 `md`、`2xl`：

| 前缀       | 宽度 | 含义                                     |
| ---------- | ---- | ---------------------------------------- |
| `sm:`      | 640  | 手机窄屏分界                             |
| `compact:` | 900  | 右侧面板铺满、双栏对话框堆叠、分镜表单列 |
| `lg:`      | 1024 | 首页收成两列                             |
| `xl:`      | 1280 | 顶栏操作全部展开                         |

CSS 的 `@media` 手写这四个数字，JS 用 `BREAKPOINT` / `minWidth()`。容器查询（`@container`）按容器自身宽度，不在此列。

## 圆角

六级，数值以 Nova 的 10px 基准圆角为中心；组件按角色选令牌，不在组件里另算圆角。

| 令牌          | 值  | 用在                                                             |
| ------------- | --- | ---------------------------------------------------------------- |
| `rounded-xs`  | 4   | 键帽、复选框、行内代码                                           |
| `rounded-sm`  | 6   | 标签、角标、24 高的小控件、旧式分段块里的项                      |
| `rounded-md`  | 8   | 28–36 高的按钮、输入框、菜单项、工具条按钮、Tooltip、≤ 64 缩略图 |
| `rounded-lg`  | 10  | Nova Select、Segmented、菜单、弹层、工具条、提示条、大缩略图     |
| `rounded-xl`  | 14  | 外壳卡片、面板、生成器、Nova 对话框                              |
| `rounded-2xl` | 18  | 大型卡片和特殊页面外壳；Nova 对话框不套用这一级                  |

嵌套元素仍尽量保持同心，但 Nova 组件的 `lg` 外壳与 `md` 菜单项是固定配方，不为了机械相减而新增数值。

画布 DOM 不跟随上述 Nova 圆角：节点卡片、播放器、Markdown 编辑器和节点编辑器用 `rounded-canvas-card`（16，对应 `canvas-core/src/renderers.ts` 的 `RADIUS`），节点内部图标用 `rounded-canvas-control`（12）。这些令牌与 `canvas-core/src/theme.ts` 的画布语义对应，保证 DOM 与 GPU 卡片外形一致。

## 字号

界面正文 13，阅读和输入 14。字重只用 400 / 500 / 600。

| 令牌        | 字号 / 行高 | 用在                             |
| ----------- | ----------- | -------------------------------- |
| `text-2xs`  | 11 / 14     | 角标、键帽、分组标签             |
| `text-xs`   | 12 / 16     | 说明、元信息、小按钮             |
| `text-sm`   | 13 / 18     | 界面默认：按钮、菜单、表格、正文 |
| `text-base` | 14 / 22     | 提示词、Markdown、卡片标题       |
| `text-lg`   | 16 / 22     | 对话框标题                       |
| `text-xl`   | 20 / 28     | 页面标题（故事板、登录）         |
| `text-2xl`  | 26 / 32     | 首页大标题，字距 −0.02em         |

Nova 组件引用 `text-sm`、`text-base` 等语义类，但数值仍取本表。Nova 默认 `text-sm` 为 14/20，本应用保持 13/18；字号和行高的整体替换会扩大既有布局，待单独评估，不在控件迁移时顺带改令牌。

同一字号在不同角色下需要不同行高时，组合固定在令牌里，组件里不写小数行高：

| 角色                               | 字号 / 行高 | 用法                        |
| ---------------------------------- | ----------- | --------------------------- |
| 阅读正文（提示词、脚本、Markdown） | 14 / 22     | `text-base`（本身即 14/22） |
| 多行说明（对话框正文、多行备注）   | 13 / 20     | `.ui-note`                  |
| 短说明、字段标签、元信息           | 12 / 16     | `text-xs`、`.ui-help`       |
| 角标、键帽、菜单分组标签           | 11 / 14     | `text-2xs`                  |

## 控件高度

| 高度    | 用在                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------ |
| 24      | 标签、节点卡片里的小按钮、`.ui-input-xs` 紧凑输入（表格和列表行内编辑）                          |
| 28      | `.ui-btn-sm`：面板和工具条里的次要操作、对话框关闭按钮                                           |
| 32      | 默认：`.ui-btn`、`.ui-input`、Nova Select / Segmented、贴着元素的工具条按钮                      |
| 36      | `.ui-btn-lg`、`.ui-input-lg`、大号 Segmented：页面主操作和设置表单；底部和顶部工具条按钮         |
| 40 / 44 | `.ui-bar-sm` / `.ui-bar` 工具条外框的最小高度；放不下时自动换行，调用方不再写 `h-auto flex-wrap` |

Nova Switch 是独立的 32 × 18.4（`--switch-w` / `--switch-h`），圆钮 16（`size-4`），checked 位移 14；不套用控件高度阶梯。Nova 确认 / 输入对话框里的输入和按钮用默认 32。

## 对话框与提示条

- 对话框有两种壳：工作面板（设置、生成历史、分镜表、序列等）正文和标题行仍按 20 排版；Nova 确认框和输入框统一 16 内边距、16 内容间距、最大宽 `max-w-sm`，输入和按钮高 32。项目打包对话框暂沿用 `.ui-dialog-pad` 的 20–24。
- 浮动的 Nova 对话框用 `rounded-xl`、`bg-menu`、`ring-1 ring-line`，不另加大阴影；全屏工作面板保留 `rounded-none bg-surface`。遮罩保留 `scrim` 令牌，并支持细 backdrop blur。
- 对话框标题用 `text-base leading-none font-medium`；说明文字成段时用 13/20 的多行说明，只有一行的短说明仍用 12/16。
- 提示条贴在顶栏下方 64、离左右 12（`--chrome-top` / `--chrome-inset`）。普通消息最低 36；带操作按钮的按 40 排版：上下 4、按钮 28、文字与按钮间距 12，多行时自然增高。

## 图标

`ui/icons.tsx`：Lucide 的 24 画板线框图标，按用途起名（`workflow`、`presets`、`gridSplit`……），只收录用到的；不走 React 的画布覆盖层用同一套的 `iconElement()`。界面里不用文字符号（`×` `▶` `‹›` `↑↓`）代替图标。

尺寸只有五档，类型上限定为 `IconSize`。图标比旁边的文字大 2–3：

| 尺寸 | 用在                                                            |
| ---- | --------------------------------------------------------------- |
| 12   | 角标、标签里，`text-xs` 小按钮里的下拉箭头，实心的播放 / 停止   |
| 14   | 24–28 高的按钮、`.ui-bar-sm` 工具条、分段控件、`text-sm` 标题旁 |
| 16   | 默认：32–36 高的按钮、菜单项、工具条、输入框里的搜索图标        |
| 20   | 40 高的大方块（首页快速开始、新建画布），底部工具条的添加按钮   |
| 24   | 空状态、节点卡片中央的类型图标                                  |

线宽随尺寸换算：12 → 1.25px，16 → 1.5px，20 及以上 1.75px。播放、暂停、停止画实心。画幅图标（`AspectGlyph`）按同样的 1.5px 线宽绘制。

## 层级与材质

| 高度 | 阴影         | 用在                                                |
| ---- | ------------ | --------------------------------------------------- |
| 1    | `--shadow-1` | 静止的卡片（`shadow-1`）                            |
| 2    | `--shadow-2` | 浮动工具条、卡片悬停                                |
| 3    | `--shadow-3` | Nova `shadow-md` 数值：生成器、菜单、弹层、提示条   |
| 4    | `--shadow-4` | 特殊大型浮层；Nova 对话框只用细描边，不叠加这层阴影 |

- `--float`：小面积工具条，92% 实底加 `--blur-float`（20px）模糊。
- `--menu`：菜单和弹层，98% 实底加 `--blur-menu`（24px）模糊，盖在图片上也读得清。
- 深色主题给浮层顶边加一道 1px 高光（`--edge-light`），浅色主题靠细描边和阴影。
- 对话框和生成器的阅读、输入区域使用实色 `surface`。生成器底部操作区有独立分隔线，滚动时持续可达。
- 首页按「标题与主操作 → 快速开始 → 最近项目」分区。快捷入口使用轻材质，作品封面承担视觉重点；真实项目排在新建占位之前，新建操作保留在标题区和列表末尾。

## 动效

| 令牌         | 时长  | 用在                                                  |
| ------------ | ----- | ----------------------------------------------------- |
| `--dur-fast` | 120ms | 悬停、按下、颜色变化                                  |
| `--dur-base` | 180ms | 菜单和弹层弹出、卡片抬起、开关和复选框                |
| `--dur-slow` | 280ms | 对话框、助手面板、分段滑块、内容切换                  |
| `--dur-move` | 360ms | 大块位移：侧栏收起展开、工作流 ↔ 故事板整页切换、封面 |
| `--dur-exit` | 140ms | 所有浮层的退场                                        |

- 曲线：进场的位移和缩放用 `--ease-spring`，颜色用 `--ease-standard`，退场用 `--ease-exit`（加速离开，不回弹）。Motion 的时长和曲线集中在 `ui/motion.ts`，与这些令牌一一对应；组件里不写散落的动画数值。
- Tailwind 的 `transition-colors` 等默认就是 120ms 加标准曲线，组件里不写 `duration-*`。简单悬停、按下、颜色和尺寸过渡仍用 CSS，不套 Motion。
- **Motion 用法**：根部 `MotionProvider` 用 `LazyMotion strict` 异步加载 `domAnimation`，并用 `MotionConfig reducedMotion="user"` 跟随系统偏好。浮层打开处写成 `<AnimatePresence>{open && <X />}</AnimatePresence>`（从 `ui/motion` 导入），X 的浮层根元素用 `m.*` 和 `useOverlayMotion(...)` 声明 `exit`；Base UI 的 `Popup` / `Backdrop` 通过 `render` 交给 `m.*`，禁止直接使用 `motion.*`。位移、缩放、原点和退场方向统一选 `ui/motion.ts` 里的变体。
- **进场与退场**：菜单、弹层从锚点那一侧长出（`data-side="above|below"`，Base UI 定位的弹层是 `top|bottom`，决定变换原点和 4px 位移），从 97% 缩放淡入；提示条从上方落下；底部提示条从下方升起；右侧面板从右侧滑入；对话框遮罩淡入、面板从 98.5% 略微上浮着弹出，避免大面积文字明显缩放。`AnimatePresence` 等 `exit` 播完再卸载，退场比进场快，位移和缩放也比进场小；收起期间标 `data-plein-exiting`，不响应指针、Esc 和点外面。
- **仍用 CSS 的浮层**：Base UI 自己管理挂载的下拉与菜单（`ui/Select.tsx`、`ui/MenuSelect.tsx`）保持 `data-starting-style` / `data-ending-style` 和 `ui-pop-in` / `ui-pop-out`，不要再套 `AnimatePresence`。这些 CSS 动画的起止仍由 `--pop-from` / `--pop-to` / `--pop-origin` 决定；View Transitions 也继续使用现有关键帧。
- **从触发点长出**：Base UI 定位的弹层原点取定位器给的 `--transform-origin`，碰撞平移或翻转后仍指向触发按钮；手动定位的浮层用 `--pop-origin`，Motion 变体读取同一组 CSS 变量。下拉和弹层下方放不下时保留最低高度（下拉 168、弹层 200，矮窗口不超过 40vh），溢出交给定位器翻到另一侧，不压成一两行。
- **提示气泡接力**：只有第一个提示等 450ms；移出后气泡多留 150ms，期间移到另一个带说明的按钮，同一个气泡滑过去换字，不重新弹出。按下、键盘、滚轮和窗口失焦仍立即收起。
- 菜单项悬停：底色移入立即出现、移出时淡掉。
- **页面切换**：工作流 ↔ 故事板用 `slideView` 左右滑；首页 ↔ 画布用 `zoomView`，被点的项目卡片放大成画布、回首页时缩回卡片，Logo（`.app-brand`）和右侧操作区（`.app-actions`）滑到新位置，时长 `--dur-move`。都基于 View Transitions，减少动态效果时直接切。
- **连续操作**：新转场接管旧转场并释放旧共享元素名称；旧完成回调不能擦除新转场标记。再次选择当前可见视图，也会取消尚未执行的另一个目标。
- **稳定与跟手**：主题卡片、导航、面板容器在切换中保留，输入框随内容变化的高度即时更新；按钮用轻微按下反馈，不改变布局尺寸。位移悬停只用于精确指针，触屏操作保持可见。
- 循环的环境动画（吉祥物、运行中的脉冲、加载圈）不受这些令牌约束。
- 系统开启“减少动态效果”时，`ui/motion` 的 `AnimatePresence` 不再保留退场队列，关闭即卸载，`MotionConfig` 同时关闭位移和缩放动画；末尾 `styles/motion.css` 仍将 CSS 动画和过渡压至 0.01ms，取消延迟和循环，不清除画布定位所需的 `transform`。首页悬停位移和小满眼睛跟随也停用，不确定进度保留静态状态提示。

## 状态

| 状态                   | 表现                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 悬停                   | `--hover` 底，文字从 muted 变 ink                                                                                             |
| 按下 / 打开 / 当前工具 | `--active` 底                                                                                                                 |
| 选中（选项、分段）     | Nova 分段用 `hover` 灰底和滑动的选中底；选项卡片用 `accent-soft` 加 `accent` 描边                                             |
| 焦点                   | 按钮（`.ui-btn`、`.ui-bar-btn`）2px 60% `accent` 贴边外框；其他元素 2px `accent`、偏移 2；输入框 1px `accent` 描边加 3px 柔光 |
| 禁用                   | 40% 不透明，没有悬停效果；主按钮禁用改为 `surface-3` 底加 `ink-subtle` 字，不再是半透明黑                                     |

## Nova 组件翻译规则

`apps/web/components.json` 只供 shadcn CLI 识别 `base-nova`、Lucide、样式入口和源码位置；aliases 使用相对路径，项目没有也不新增 `@/` 别名。**组件源码手工翻译进 `src/ui/`，不要在仓库里运行 CLI 直接覆盖源码。** 保留现有导出名、props 和调用方，Base UI 负责的键盘、焦点与 ARIA 行为不因换样式而改变。

- 类名合并统一用 `ui/cn.ts` 的 `cn()`（`clsx` + `tailwind-merge`）；变体需要时用 `class-variance-authority`。自定义阴影、`text-2xs` 和控件高度已注册冲突分组，`ui-*` 类不参与合并。
- 数值只取现有令牌：不引入 shadcn 的变量别名块、Geist 字体、`tw-animate-css`、`shadcn/tailwind.css` 或任意值。Nova 的进退场类不搬入，继续使用现有 `Presence` / `data-ending-style`；Base UI 状态直接写 Tailwind `data-[open]:` 等变体。
- 语义类按应用令牌翻译：`bg-muted` / 悬停灰 → `bg-hover`，`bg-popover` → `bg-menu`，`border-border` / `border-input` → `border-line`，`ring-ring` → 本文「状态」里的 accent 焦点规则，`text-muted-foreground` → `text-ink-muted`，`bg-primary` / `text-primary-foreground` → `bg-primary` / `text-on-primary`，`destructive` → `danger`。同名变量不直接照抄语义。
- 图标统一走 `ui/icons.tsx`，不引入 `lucide-react`；缺少的 Lucide 图标在该文件补充。画布相关令牌、节点卡片和业务组件样式不随 Nova 控件迁移。

## 通用控件

| 类                                                                                                                                                                     | 说明                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.ui-bar` / `.ui-bar-sm` / `.ui-bar-btn` / `.ui-bar-sep` / `.ui-bar-text` / `.ui-bar-check`（复选项）；纯图标按钮加 `.ui-icon-btn`；`.ui-bar-bare` 同尺寸不带底色      | 工具条：页头、底部工具条、结果 / Frame / 多选工具条；首页和画布顶栏都用 44 的 `.ui-bar`，Logo 共用 `ui/Brand.tsx` |
| `.ui-btn` + `-primary` `-secondary` `-quiet` `-danger` `-danger-solid`，尺寸 `-xs` `-sm` `-lg`，`.ui-icon-btn`（宽 = 高），`.ui-btn-menu`（打开菜单，末尾箭头弱色）    | 按钮                                                                                                              |
| `.ui-input` / `.ui-select` / `.ui-input-lg` / `.ui-input-xs`                                                                                                           | 输入框、下拉框（`ui/Select.tsx`）；默认 32，表单对话框 36，表格和列表行内编辑 24                                  |
| `.ui-field` / `.ui-label` / `.ui-help` / `.ui-section-title` / `.ui-note`                                                                                              | 表单字段和分组标题；`.ui-note` 是 13/20 的多行说明                                                                |
| `.ui-seg` / `.ui-seg-item`，`.ui-seg-block`（铺满等分，选中底色滑动切换，需传 `--seg-n` / `--seg-i`）、`.ui-seg-tall`（图标在上）、`.ui-seg-aspect`（画幅，最多 9 项） | `ui/Segmented.tsx` 用 Nova toggle-group 外观（默认 32、大号 36）；块级类留给参数面板选画幅、分辨率                |
| `.ui-menu` / `.ui-menu-item` / `.ui-menu-label` / `.ui-sep`，两行项用 `.ui-menu-text` + `.ui-menu-desc`                                                                | 菜单、弹层（`ui/Popover.tsx`）                                                                                    |
| `.ui-dialog-scrim` / `.ui-dialog` / `.ui-dialog-pad` / `.ui-dialog-head`                                                                                               | 对话框动效与工作面板标题行；`.ui-dialog-pad` 只留给项目打包对话框的 20–24，Nova 确认 / 输入框直接用 `p-4`         |
| `.ui-toast-wrap` / `.ui-toast`（带操作加 `.ui-toast-action`）/ `.ui-tooltip`                                                                                           | 顶栏下方的提示条（普通 36、带操作 40）、悬停提示（`ui/Tooltip.tsx`）                                              |
| `.ui-chip` / `.ui-chip-btn` / `.ui-chip-remove` / `.ui-tag`（`-success` `-warning` `-danger` `-accent`）/ `.ui-badge`                                                  | 24 高的标签（`-btn` 是可点的单选下拉，`aria-pressed` 亮起）和它的移除按钮；20 高的状态标签；图片上的角标          |
| `.ui-drop-tile`                                                                                                                                                        | 96 见方的虚线投放格（上传、从画布选）                                                                             |
| `.ui-kbd` / `.ui-keycap`                                                                                                                                               | 菜单里的快捷键提示；成组出现的键帽                                                                                |
| `.ui-spinner`                                                                                                                                                          | 加载中，`size-3` / `size-4` 缩小                                                                                  |
| `.ui-run-steps` / `.ui-run-step-bar` / `.ui-run-step-label`                                                                                                            | 外部调用的四步进度（提交、排队、生成、保存）                                                                      |
| `.ui-empty`（`-fill` `-compact`）                                                                                                                                      | 空状态（`ui/EmptyState.tsx`）                                                                                     |
| `.ui-pop`（`.ui-pop-up` `.ui-pop-right`）                                                                                                                              | 其他弹出的浮层的进场方向                                                                                          |

下拉与滑块不使用原生 `<select>` 或 `<input type="range">`：下拉统一用 `ui/Select.tsx`，单值滑块统一用 `ui/Slider.tsx`。滑块的 `onValueChange` 用于拖动中的实时预览，`onValueCommitted` 用于松手或键盘交互完成后的提交；调用方按原有事务与撤销语义选择回调，不把每一帧预览额外变成一次提交。

纯图标的控件一律显式标记（`.ui-icon-btn`、`Segmented` 的 `iconOnly`），不要用 `:has(> svg:only-child)` 推断：`:only-child` 不看文字节点，图标加文字的控件也会命中。

新组件先按上一节翻译 Nova 源码并复用这里的令牌；确有多个组件共享且 Nova 工具类覆盖不到的样式，才在 `styles/controls.css` 增加通用类。通用控件都在 `@layer components` 里，组件上的 Tailwind 工具类能直接覆盖，不需要 `!`；`styles/` 下其他文件是不分层的页面样式，别和同属性的工具类混用。已被 Nova 接管的旧类删除前先检索全部调用方，仍被原生控件或业务组件使用的类保留。

## 共享模块

弹层、下拉、菜单、开关、面板和对话框基于 [Base UI](https://base-ui.com)（`@base-ui/react`，无样式组件）：键盘操作、焦点圈定与归还、ARIA、定位与碰撞翻转、嵌套浮层的点外面和 Esc 都交给它，样式和动效仍用本文档的类和令牌。新的交互控件（菜单、复选、滑块、标签页等）先找 Base UI 里对应的组件再套样式，不要从头手写。

| 模块                  | 用途                                                                             |
| --------------------- | -------------------------------------------------------------------------------- |
| `ui/cn.ts`            | Nova 类名合并：条件类名、Tailwind 冲突和应用自定义工具类                         |
| `ui/Select.tsx`       | Nova 下拉触发器、弹层、选项和滚动箭头（Base UI Select）                          |
| `ui/Slider.tsx`       | Nova 单值滑块：实时预览与完成提交分离（Base UI Slider）                          |
| `ui/MenuSelect.tsx`   | 轻量 ghost 触发器 + Nova 单选菜单（Base UI Menu）                                |
| `ui/Modal.tsx`        | Nova 工作面板的遮罩、外框和标题行（设置、生成历史、分镜表、序列、快捷键）        |
| `ui/DialogView.tsx`   | Nova 确认框 / 输入框外壳；异步确认和焦点行为不变                                 |
| `ui/Presence.tsx`     | 浮层退场：`<Presence>` 延迟卸载，`useExit()` 铺属性，`useClosing()` 判断收起中   |
| `ui/Popover.tsx`      | Nova 弹层外壳，锚定按钮并从锚点那一侧长出（Base UI Popover）                     |
| `ui/Segmented.tsx`    | Nova toggle-group 外观的分段控件，保留 fieldset/button 和选中底色滑动            |
| `ui/EmptyState.tsx`   | 空状态：图标、标题、说明、操作                                                   |
| `ui/Switch.tsx`       | Nova 开关：32 × 18.4，checked 用 primary 底                                      |
| `ui/Toast.tsx`        | 顶栏下方的提示条                                                                 |
| `ui/keys.ts`          | 快捷键的显示文本：`shortcut('mod+shift+z')` → macOS「⇧⌘Z」、其他「Ctrl+Shift+Z」 |
| `ui/format.ts`        | 时间：相对时间、「今天 14:05」、时长                                             |
| `canvas/runStatus.ts` | 运行状态的说法：阶段标签、平台、已用时长、重试倒计时、失败原因和处理建议         |
| `ui/useDismiss.ts`    | 点外面、按 Esc（可选滚轮）关闭浮层                                               |
| `canvas/hooks.ts`     | `useEngineVersion`（跟随元素的浮层）、`useDocVersion`（列表和表格）              |
