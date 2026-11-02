# 代码结构调整与系统架构调整方案

2026-11-02 · hoobnn

## 0. 这份文档是什么

[架构规划](../dev/architecture.md) 讲的是方向与原则，[代码结构评审](../dev/architecture-review.md) 记录的是
2026-11-02 那一轮已经落地的收敛。这份文档讲第三件事：**还没做的结构与架构调整，具体要调什么、
为什么调、按什么顺序调**。

- **范围**：`packages/*`、`apps/web`、`apps/server` 的代码结构与依赖结构，以及前端的依赖选型与组件复用约定。
- **不在范围**：功能排期、发布节奏，以及统一到 Nova 风格之外的视觉设计。那些见[功能规划](feature-plan.md)。
- **写法**：每一条调整都给出「现状证据 → 做法 → 理由 → 影响面 → 风险 → 验收」。
  证据全部带 `文件:行号`，可以逐条复核；结论若与仓库现状不符，以仓库现状为准。
  计数类证据都附统计口径，数字随代码漂移，执行时以重新统计的结果为准。

### 一句话结论

这个项目的**代码质量不是问题**——依赖方向无反向引用、类型层几乎没有 `any`、4460 个单测覆盖着协议与
领域模型、CI 跑完整验证。真正要调的是**结构**：元素类型的注册分散在 4 处、能力审批靠工具名特判、
17 个超过 1000 行的文件，以及前端「已有依赖能表达却自己写」的组件和行为。
`packages/doc` 里的领域逻辑可以先在包内切分，独立成包要等出现第二个消费方再做。

## 1. 现状体检

### 1.1 不要动的部分

调结构之前先承认这些是好的，避免把好东西改坏：

| 方面         | 证据                                                                                                                                          | 结论 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 依赖方向     | packages 修复后形成严格 DAG（见评审文档 §2.1），`apps/*` 之间零互引                                                                           | 保持 |
| 类型安全     | 仅 `packages/plugin-sdk/src/plugin.ts:26,47,49,57,59` 有 5 处带 lint 豁免的泛型 `any`（异构定义列表），0 个 `@ts-ignore` / `@ts-expect-error` | 保持 |
| 测试         | 571 个文件 / 4460 个用例，含协议、领域模型、渲染与集成                                                                                        | 保持 |
| 打包门禁     | 首页首屏 JS gzip 实测 173.15 KiB，门禁 300 KiB（`apps/web/scripts/check-home-bundle.mjs`）                                                    | 保持 |
| 插件隔离     | 第三方插件跑在 Node 权限模型的子进程里，网络出口经 `scopedFetch` / `scopedSocket` 收敛                                                        | 保持 |
| 单一事实来源 | 文档是 Yjs 唯一事实来源，运行时状态（画布选中）确实没进文档                                                                                   | 保持 |
| 无样式组件层 | 弹层、菜单、下拉、开关基于 Base UI，源码在 `apps/web/src/ui/*`，规则写在 `docs/dev/design-spec.md:180`                                        | 保持 |

### 1.2 需要调整的问题（按影响排序）

编号与 §3 的调整项一一对应。

| #   | 问题                              | 规模                                                      | 影响                                             |
| --- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| A   | 元素类型的注册分散在 4 处         | 154 处元素专属 kind 分支 / 104 处 nodeType 分支           | 加特殊节点要改多处 if 链；插件元素声明了但到不了 |
| B   | `packages/doc` 混着领域逻辑       | 非测试 5697 行里 2693 行是领域记录（47.3%）               | `commands.ts` 名不副实，文档包职责不清           |
| C   | `production.selection` 名字有歧义 | 1 个字段，6 个前端读点                                    | 被误当成违规的运行时状态                         |
| D   | 能力审批按工具名特判              | 调度器 2 处 + 方案确认 1 处 + 审批理由 8 处               | 新能力要改调度器，与「能力自带副作用等级」相悖   |
| E   | 服务端路由挂载顺序决定正确性      | 1 处                                                      | 已有集成用例兜底，但约束只写在注释里             |
| F   | 数据访问约定不明确                | 12 个文件直接 import Drizzle，其中 2 个本身就是存储模块   | 路由里有直接写库，迁移时容易漏改                 |
| G   | 大文件                            | 17 个文件 1000–2600 行，26 个超过 800 行（不含 `bench/`） | 改动冲突高、评审困难                             |
| H   | Zustand 订阅未用选择器            | 11 处全量订阅                                             | 无关字段变化触发整块重渲染                       |
| I   | 前端「已有依赖能表达却自己写」    | 54 处原生 `<select>`、19 处原生滑块、手写提示与退场动画等 | 交互与样式不一致，可访问性与焦点管理各自实现     |

---

## 2. 调整原则

1. **行为优先于结构。** 结构调整的验收标准是「行为不变且可证」，不是「文件变小」。
   每一步都要有能跑的测试或可量的门禁。
2. **先纯后杂。** 纯函数搬移 → 声明式化 → 跨包迁移。跨包迁移只在有明确消费方时做。
3. **一次一个包。** 跨包迁移要单独一轮，避免与其它改动混在一起，回滚时说不清是哪一个引起的。
4. **能力自带元数据。** 凡是「某个能力需要特殊处理」的地方，都要先问「能不能让能力自己声明」。
5. **有意的重复要钉住，不要合并。** 协议层与领域层各留一份 schema 是有意的（协议包要能独立校验请求），
   这种重复用契约测试防漂移，而不是强行合并。
6. **优先复用成熟依赖，严禁重复造轮子。** 已有依赖能正确表达的组件和行为，不自行设计实现；
   新依赖优先选源码可控、能套用令牌的方案；界面风格统一为 shadcn/ui Nova；同一用途只留一个依赖、同一依赖只留一个版本。详见 §3.I。
7. **门禁与修复同批落地。** 新加的检查要么和对应修复一起提交，要么以当前基线做递减式检查，
   不先加一个必然变红的硬门禁。

---

## 3. 调整项

### A. 元素类型注册机制统一

#### 现状证据

架构文档 [dev/architecture.md:197](../dev/architecture.md) 明文要求：「一个元素类型 = doc schema +
渲染器 + 可选 DOM 编辑器 + 可选 flow node，内置类型全部走同一注册机制」。实际分散在四处：

1. **doc schema 轴** — `packages/doc/src/types.ts:8` 的 `ElementKind` 是 7 个 kind 的封闭联合
   （`image` / `video` / `audio` / `markdown` / `node` / `frame` / `sequence`）。
   `packages/doc/src/doc.ts:52` 的 `isKind` 与 `:325` 起的 `readElement`（`:327` 判断）是硬闸门——
   **kind 不在联合里的元素在读取时直接被丢弃**。

2. **渲染器轴** — `packages/canvas-core/src/renderers.ts:385` 的
   `private map = new Map<ElementKind, ElementRenderer>()`，`:398` 的 `register(kind: ElementKind, …)`
   让**按 nodeType 注册在类型上就不可能**；`:403` 查找失败时回落到通用占位卡片 `cardRenderer`。
   所有节点共用 `nodeRenderer`（`:306`），内部不按 nodeType 分发。
   `apps/web/src/canvas/CanvasView.tsx` 也从不注入自定义 registry（`packages/canvas-core/src/engine.ts:179`
   才有 `opts.renderers ?? new RendererRegistry()` 这个口子）。

3. **DOM 编辑器轴** — 没有任何注册表（`elementRegistry` / `ELEMENT_TYPES` 一类符号全仓零命中）。
   靠字面量 if 链分发：`apps/web/src/canvas/CanvasView.tsx:137-141`（双击打开哪个面板）、
   `apps/web/src/features/generator/Generator.tsx:88-106`（编辑器尺寸与内容）、
   `apps/web/src/shell/ResultBar.tsx:91,176,219`、`apps/web/src/shell/CanvasMenus.tsx:459`。

4. **flow node 轴** — `packages/plugin-sdk/src/node.ts:14` 的 `NodeDefinition`，按 `type` 字符串
   （`vendor/name`）注册，与前三条的键完全不同。

**代价要分两种情况看**：

- **新增一种节点类型**（高频）：kind 恒为 `'node'`，`nodeType` 是开放字符串，通用 `nodeRenderer`
  直接接住，**不需要改 doc 的联合和渲染表**。要改的是 `packages/nodes` 的声明，加上前端那几条 if 链
  ——如果这种节点要专门的打开行为或编辑器的话。
- **新增一种媒体类 kind**（罕见）：才需要同时改 doc 联合、渲染表与前端分发。

生产代码里比较 `.kind` 与 kind 字面量的地方共 324 处，其中 154 处是元素专属 kind
（`markdown` / `node` / `frame` / `sequence`），分布在 67 个文件里；比较 `nodeType` 字面量的 104 处
分布在 53 个文件里（`plein/storyboard` 28 次、`plein/sequence` 24 次、`plein/character` 14 次、
`plein/scene` 13 次……）。

> 统计口径（可复现）：`apps/*`、`packages/*` 下的 `.ts` / `.tsx`，排除 `*.test.*` / `*.spec.*` / `*.d.ts`
> 与 `node_modules` / `dist`，按 `\.kind\s*(===|!==|==|!=)\s*'<kind>'` 与
> `nodeType\s*(===|!==|==|!=)\s*'plein/[a-z-]+'` 计数。
> 元素专属 kind 的 154 处按目录分布（处数 / 文件数）：`apps/web` 76 / 34、`apps/server` 23 / 9、
> `packages/capabilities` 20 / 10、`packages/doc` 19 / 6、`packages/canvas-core` 14 / 6、`packages/nodes` 2 / 2。

另有一处**同一件事的两份实现**：节点声明转成画布元素，`packages/capabilities/src/story/nodes.ts:16`
的 `nodeElementOf(NodeDescriptor)` 与 `apps/web/src/canvas/nodes.ts:113` 的 `nodeElement(NodeInfo)`
各写一遍 `kind` / `nodeType` / 端口映射，只有默认尺寸的算法不同。

#### 已确认的两个具体缺陷

- **`sequence` 这个 kind 是死的。** 它在 `ElementKind` 联合里、在 `theme.ts:60` 有颜色、在
  `renderers.ts:51` 有标签、在 `apps/web/src/canvas/outline.ts:30` 有分支，但
  `RendererRegistry` 没为它注册渲染器（`renderers.ts:389-394` 只注册了 6 个 kind）。
  同时全仓生产代码**从不创建** `kind: 'sequence'` 的画布元素——序列实际是 `kind: 'node'` +
  `nodeType: 'plein/sequence'`。画布元素的 `kind: 'sequence'` 只在 `packages/doc/src/production.test.ts:350`
  一个测试里出现过；`apps/web/src/features/creation-guide/facts.ts:21-33` 的 `GuideTargetKind` 也有
  `'sequence'`，那是创作向导的目标类型，同名不同义，检索时别混。
  即：**类型里有、渲染表里没有、实际不发生**——一旦发生就是静默降级成灰色占位卡片。

- **插件元素类型是一条没有生产者也没有消费者的链路。**
  `packages/plugin-sdk/src/contributions.ts:72` 的注释写着「文档里存为 `kind: 'custom'` + `customType`」，
  但 **`'custom'` 不在 `ElementKind` 里，`CanvasElement` 上也没有 `customType` 字段**——注释与现实不符。
  链路是：服务端注册（`apps/server/src/plugins/registry.ts:215`）→ 写进目录
  （`apps/server/src/plugins/routes.ts:79-89`）→ 前端取到（`apps/web/src/api/client.ts:172`）
  → `apps/web/src` 里 `catalog.elements` 的非测试引用是零。
  而生产者一侧：内置插件没有一个声明元素类型；第三方插件在
  `apps/server/src/plugins/external.ts:70` 与 `apps/server/src/plugins/install.ts:269-270` 被明确拒绝。
  [插件文档](../dev/plugins.md) 把自定义元素渲染规划为沙箱 iframe，尚未实现。

#### 做法

分三步，每步都可独立验收：

##### A1 — 先把「事实」修对（不改架构，只修错）

- `ElementKind` 删掉 `sequence`，连同 `theme.ts:60`、`renderers.ts:51`、`outline.ts:30` 的死分支。
  删掉能让「类型即事实」重新成立，注册渲染器等于给一个不存在的类型编造行为。
  删之前核对 `packages/doc/src/migrate.ts:146` 的 `LEGACY_KINDS`：它没有 `sequence` 条目，
  `:164` 的兜底会把未知旧 kind 映射为 `{ kind: 'node', nodeType: old.kind }`，旧文档不会因此丢元素。
- 修 `packages/plugin-sdk/src/contributions.ts:72` 的注释，写明「元素类型尚未开放，第三方插件声明会被拒绝」。
- 节点转元素的两份实现：尺寸差异若无意就合并成一个工厂；若有意就加契约测试钉住共同字段。

##### A2 — 前端建立客户端的节点注册表

- 在 `apps/web` 建一张 `nodeType → { renderer?, open?, editor?, size? }` 的客户端注册表，
  内置特殊节点（分镜、序列、角色、场景……）在这里登记一次。
  **catalog 只决定「有哪些节点可用」**，不承载渲染器和编辑器：`NodeDescriptor`
  （`packages/plugin-sdk/src/node.ts:77-92`）与 `Catalog`（`packages/plugin-sdk/src/catalog.ts:63-76`）
  都是可序列化的 HTTP 数据，推导不出 Pixi 渲染器或 React 面板。
- `RendererRegistry` 增加按 `nodeType` 查找的可选层：先查 nodeType，查不到落回 kind。
  `CanvasView.tsx` 改为注入由这张表生成的 registry（`engine.ts:179` 已经支持）。

##### A3 — DOM 编辑器改成表驱动

- 把 `CanvasView.tsx:137-141` 的双击分发、`Generator.tsx:88-106` 的编辑器选择、
  `ResultBar.tsx` 与 `CanvasMenus.tsx` 的分支，收进 A2 的同一张表。
- `catalog.elements`：在沙箱 iframe 方案落地前**从 `Catalog` 里删掉**，等真正能上屏时再加回；
  不保留没有生产者也没有消费者的字段。

#### 理由

- **特殊节点的打开行为与编辑器散在多个 if 链里**，加一种特殊节点要找全这些分支，漏一处就是静默错误。
  A2 + A3 之后，内置特殊节点只在一张表里登记一次。
- **`sequence` 这种「类型里有、行为里没有」的项是纯负债。** 它让 `ElementKind` 看起来有 7 种，
  实际只有 6 种。
- **插件元素是「SDK 声明了、宿主拒绝了、前端不读」的半成品。** 不修的话，
  `defineElementType` 对第三方开发者是个空承诺。
- **第三方自定义渲染不该伪装成 catalog 数据。** 可执行的渲染能力要走沙箱，这是插件隔离的前提。

#### 影响面

`packages/doc`（类型）、`packages/canvas-core`（渲染表 + 引擎注入）、`packages/plugin-sdk`（注释 + `Catalog`）、
`apps/server/src/plugins`（目录输出）、`apps/web`（注册表 + 注入点 + 编辑器分发）、
`packages/capabilities`（节点工厂）。

#### 风险

- A1 **低**：死代码删除与注释修正。
- A2 / A3 **中**：渲染器查找顺序变化会影响节点上屏；编辑器表化会影响面板打开行为。
- 有现成回归保护：`packages/canvas-core/src/renderers.test.ts`、
  `apps/web/src/features/sequence/SequenceEditor.test.tsx`（893 行）、
  `apps/web/src/features/storyboard/ShotWorkbench.test.tsx`（1505 行）。
- **不依赖 B**：渲染键与编辑器分发只涉及 `kind` / `nodeType`，不读 `reviews` / `production` / `deliveries`。

#### 验收

- 每种 `ElementKind` 都有确定的渲染路径，不再有「回落到占位卡片」的情况。
- `Catalog` 里不再有不生效的 `elements` 字段。
- `CanvasView` / `Generator` / `ResultBar` / `CanvasMenus` 里按 `nodeType` 字面量分发打开行为与编辑器的分支清零，
  由客户端注册表取代。
- 按上面的口径重新统计 `nodeType` 字面量比较数，作为跟踪指标（当前基线 104）。

---

### B. `packages/doc` 的领域逻辑切分

#### 现状证据

`packages/doc` 非测试代码 5697 行，按职责切分：

| 类别     | 模块                                                                                                                                                                                                                       | 行数 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 文档原语 | `doc.ts` 411、`types.ts` 222、`commands.ts` 1136、`layout.ts` 434、`migrate.ts` 290、`clipboard.ts` 212、`inputs.ts` 18、`sizes.ts` 34、`ids.ts` 7、`composition.ts` 9                                                     | 2773 |
| 领域记录 | `continuity.ts` 759、`source-map.ts` 504、`production.ts` 347、`sequence-instances.ts` 307、`production-goal.ts` 256、`delivery.ts` 139、`shotGroup.ts` 136、`video-segment.ts` 116、`reviews.ts` 86、`review-types.ts` 43 | 2693 |

领域记录占 47.3%。`packages/doc/src/types.ts:88-90` 的 `reviews?` / `production?` / `deliveries?`
**已经是引用领域类型**（`:1-5` 从 `production.ts`、`review-types.ts`、`delivery.ts` 导入），不是内联结构。

`commands.ts` 1136 行里，**末尾 7 个命令（`:792`–`:1136`，345 行，30%）全是序列专属**：
`fixSequenceInstance`、`duplicateSequenceInstance`、`editSequenceInstance`、
`reorderSequenceInstances`、`addFixedSequenceInstance`、`removeSequenceInstance`、
`replaceSequenceSegment`。前 34 个命令（`:109`–`:773`）才是通用的元素命令。

`packages/doc/src/continuity.ts:465,485` 的 `resolvedShotState` / `continuityDependencies` 是纯函数，
已有直接单测（`packages/doc/src/continuity.test.ts`）；非测试调用方只有前端
`apps/web/src/features/storyboard/ShotStatePanel.tsx:77,504`，服务端只在测试里用到
（`apps/server/src/checkpoints/continuity.test.ts:244`），生产代码对连续性记录只做保存、导出导入与资产收集。

`@plein/doc` 的公开导出在 `packages/doc/src/index.ts:19-27`，全仓非测试代码有 198 个文件、202 处 `from '@plein/doc'`。

#### 做法

##### B1 — 包内切分（不跨包、不改公开导出）

- `commands.ts` → `commands.ts`（通用 34 个命令）+ `commands/sequence.ts`（7 个序列命令）。
- 领域记录模块挪进 `packages/doc/src/domain/` 子目录，`index.ts` **保持原样重导出**，调用方不动。

##### B2 — 建立 `@plein/domain`（有第二个消费方时再做）

- 触发条件：服务端或另一个包需要领域推导（例如服务端要按连续性做校验），而不只是保存与搬运。
- 届时把领域模型与纯计算搬进去：`ProductionRecord`、`ContinuityRecord`、`SourceMapRecord`、
  `DeliveryRecord`、`CreativeReview`、`VideoSegment`、`SequenceInstance`，以及 `resolvedShotState`、
  `continuityDependencies` 这类纯函数。`@plein/domain` 只依赖 `@plein/plugin-sdk`（类型），不依赖 `yjs`。
- 迁移期间 `@plein/doc` 继续转出这些类型，调用方分批切到 `@plein/domain`，最后一步再删转出
  （评审文档 §2.1 的 `Catalog` 下沉就是这个模式）。
- **Yjs 里的数据形状不变**，只是 TypeScript 类型与纯函数换了包，**不需要 schema 迁移**。

#### 理由

- **`commands.ts` 30% 是序列专属，这个文件已经名不副实。** 改序列逻辑时必然碰到通用命令的代码。
- **事实来源唯一 ≠ 数据模型必须长在文档包里。** 领域记录与 Yjs 原语放在同一层，让 `doc` 的职责边界模糊；
  先在包内用目录把边界划清，成本最低。
- **独立成包现在没有消费方。** 纯函数已能单测，前端是唯一推导方；没有第二个消费方就新建包，
  付出的是约 200 处 import 的迁移成本，换不来可验证的收益。

#### 影响面

B1：`packages/doc` 内部。B2：`packages/doc`、新增 `packages/domain`、`packages/capabilities`、`packages/nodes`、
`apps/web`、`apps/server`，约 200 处 import。

#### 风险

- B1 **低**：包内搬移，公开导出不变。
- B2 **中**：跨包迁移，import 改动量大；数据形状不变，所以不涉及文档迁移。

#### 验收

- B1：`commands.ts` 只剩通用命令；`@plein/doc` 的公开导出与切分前一致（导出列表对比为空 diff）。
- B2：`@plein/domain` 不 import `yjs`；`@plein/doc` 不再导出领域记录类型；文档快照与迁移用例全绿。

---

### C. `production.selection` 的边界澄清

#### 现状证据

架构文档 [dev/architecture.md:74](../dev/architecture.md) 规定「运行时状态（执行进度、选中、悬停）
不进文档」。而 `packages/doc/src/production.ts:61` 的 `ProductionRecord` 上带着 `selection`，
`:252` 的 `selectProductionTarget()` 往文档里写「当前聚焦的镜头 / 序列 id」。

**但它不是纯粹的本地 UI 焦点**：

- `packages/capabilities/src/production.ts:70` 的 `edit_production` 能力
  （`op.action === 'select'` 分支）会写它。
- 该能力注册在 `apps/server/src/agent/tools.ts:1073` 的 `serverCapabilities` 里，
  也就是说**内置智能体与 MCP 都能写它**——能力描述里明写「Agent 写入明确标记 source=agent」。
- 读它的 6 个非测试点全在前端：`apps/web/src/features/creation-guide/facts.ts:263,264`、
  `productionGoalScope.ts:12`、`CreationGuide.tsx:308,351`、
  `apps/web/src/features/storyboard/ShotWorkbench.tsx:168`。
- **服务端不读它**（`apps/server/src` 里没有 `production.selection` 的读取点）；
  `packages/doc/src/clipboard.ts:110` 的 `copyProduction` 只是复制元素时顺带带上。

结论：它是「用户与智能体共享的当前制作目标指针」——**有意的共享状态，不是漏网的运行时状态**。
文档里另一处「选中」（画布选中 `engine.selection`）确实没进文档，那条规则没有被违反。

#### 做法

##### C1 — 改名 + 写明例外（推荐）

- TypeScript 层把 `production.selection` 改名为 `production.target`（类型 `ProductionTarget`），读写点跟着改。
- Yjs 里的持久化键名**仍为 `selection`**，不升 schema 版本：改键名要整体替换子 Map，多个客户端并发迁移时会互相淘汰，
  迁移后的修改可能丢失。键名集中定义成常量并注释原因。
- 在 `docs/dev/architecture.md:74` 那条规则后面补一句例外说明：制作目标是**共享的业务指针**，
  用户与智能体都要改它，因此留在文档里；画布选中才是运行时状态。

##### C2 — 把它移出文档（不做）

- 需要新的运行时 store + 跨端同步机制，且智能体在**服务端**执行 `where: 'doc'` 的能力时没有前端 store 可写；
  要么能力降级为只读，要么引入一个服务端也能写的指针存储——那就是文档。

#### 理由

- **代码本身没有 bug，问题是名字在骗人。** 改成 `target` 并写清例外，比强行迁移便宜得多，也更诚实。
- **C2 的代价与收益不成比例**，还会多出一处状态真源，与「文档是唯一事实来源」直接冲突。

#### 影响面

`packages/doc/src/production.ts`、`packages/capabilities/src/production.ts`、
`apps/web/src/features/creation-guide/*`、`apps/web/src/features/storyboard/ShotWorkbench.tsx`、
`docs/dev/architecture.md`。

#### 风险

- **低**。持久化格式不变，不需要文档迁移；用测试钉住 Yjs 键名仍为 `selection`。

#### 验收

- 架构文档里「运行时状态不进文档」那条不再有歧义。
- 智能体仍能通过 `edit_production` 设置制作目标；已有文档的制作目标原样可读。

---

### D. 能力审批声明化

#### 现状证据

能力系统**已经有**一套声明式机制：`packages/capabilities/src/define.ts:119` 定义了
`effect: 'read' | 'edit' | 'run' | 'destructive'`，且可以是函数（按本次参数判定）。
`packages/capabilities/src/registry.ts:10` 的 `CapabilityRegistry` 统一注册与分发。

**但执行与审批路径上按工具名特判了 11 处**（`grep -rn "cap.name ===" apps/server/src` 加 1 处 `t.name ===`）：

- 调度器 `apps/server/src/agent/tools.ts`：
  - `:1155` `if (cap.name === 'run_storyboard')`：先出批次计划、可能要用户确认、返回 `needs_approval`；
  - `:1180` `if (cap.name === 'run_node')`：先做一次不花钱的输入预览，状态不对就拦下；
  - `:1205` `tools.find((t) => t.name === PROPOSE_EDIT)`：提案式编辑走「方案即确认单」的另一套流程。
- 审批理由 `apps/server/src/agent/approvals.ts:44-98` 的 `approvalFor`（`tools.ts:1162,1188` 调用它）
  内部还有 8 处：`delete_elements`、`run_frame`、`run_storyboard`、`apply_edit_plan`、`run_flow`、
  `run_node`、`perform_canvas_action`、`recover_job`，各自拼审批说明与涉及的 id。

三类特判性质不同：批次计划、输入预检、方案确认是**流程**差异；`approvalFor` 里的是**审批说明**差异。

插件侧：插件能力用的是另一套类型 `PluginCapabilityDefinition`（`packages/plugin-sdk/src/capability.ts:36-52`），
经 `apps/server/src/agent/plugin-caps.ts:26-38` 映射；第三方插件根本不能提供能力
（`apps/server/src/plugins/external.ts:71`、`apps/server/src/plugins/install.ts:269-270`）。

#### 做法

- 给 `CapabilityDefinition` 增加两类可选声明：
  - **审批说明**：`approval?: (args, ctx) => { reason, ids? }`，取代 `approvalFor` 里的按名分支；
  - **执行前流程**：`prepare?: (args, ctx) => Promise<{ proceed } | { needsApproval, plan }>`，
    覆盖批次计划、输入预检与方案确认三种形态（`propose_edit` 返回的方案本身就是确认单，
    用 `{ needsApproval, plan }` 表达，用户选定范围后按范围执行）。
- `tools.ts` 的调度器与 `approvals.ts` 改为读声明分派，去掉按名的 if；未声明的能力走现有通用路径。
- `PluginCapabilityDefinition` 与 `plugin-caps.ts` 同步支持这两个声明，**本期只对内置插件开放**；
  第三方插件提供能力需要另做 SDK、描述 RPC、宿主代理与安装策略设计，不在本项。

#### 理由

- **能力系统的价值是「声明一次，界面 / ⌘K / 智能体 / MCP / 插件共用」。**
  现在这些能力的部分行为只能写在服务端调度器里，能力定义分裂成了两份。
- **按名字特判会随能力增长线性劣化。** 现在已经 11 处。

#### 影响面

`packages/capabilities/src/define.ts`、`packages/capabilities/src/production.ts` 等声明特殊流程的能力、
`apps/server/src/agent/tools.ts`、`apps/server/src/agent/approvals.ts`、`apps/server/src/agent/edit-plan.ts`、
`packages/plugin-sdk/src/capability.ts`、`apps/server/src/agent/plugin-caps.ts`。

#### 风险

- **中。** 审批是安全相关路径，改错了会让能力绕过确认。
- 回归保护：`apps/server/src/agent/storyboard-batch.test.ts`（批次计划）、`apps/server/src/agent/agent.test.ts`
  （输入预检与审批）、`apps/server/src/runs/edit-plan.test.ts`（方案确认）、
  `apps/server/src/agent/reliability.test.ts`（审批事实恢复）。
- 迁移前先补一组对照用例：同一输入在新旧路径下得到相同的审批结果与说明。

#### 验收

- `apps/server/src/agent/tools.ts` 与 `apps/server/src/agent/approvals.ts` 里不再出现按能力名的特判。
- 对照用例全绿；内置插件能力能声明并走通「计划 → 确认 → 执行」流程。

---

### E. 服务端路由顺序显式化

#### 现状证据

`apps/server/src/app.ts:208-209` 有一段注释说明了陷阱：

```ts
// 素材来源路由要排在 creative 之前：资产文件路由 /api/assets/:id/:variant?
// 会把 /api/assets/:id/sources 当成变体名抢先匹配，来源分页就永远 404。
```

对应的两处路由：

- `apps/server/src/media-index/routes.ts:21` — `app.get('/api/assets/:id/sources', …)`
- `apps/server/src/assets/routes.ts:40` — `.on(['GET','HEAD'], '/api/assets/:id/:variant?', …)`

`app.ts` 里有 19 处 `app.route()` 挂载（`:196`–`:223`，其中 `creative` 子应用内部另挂 7 个，`:133-139`）。

**已有测试守护**：`apps/server/src/media-index/adopted-history.test.ts:65-67` 通过 `bootServer()` 起完整应用，
请求 `/api/assets/:id/sources` 并断言 200；挂载顺序倒退时这条用例会变红。
问题在于它是业务用例顺带覆盖，约束本身只写在注释里，读测试的人看不出它在守路由顺序。

#### 做法

- **短期**：加一条专门的路由顺序回归用例（命名直说「来源路由不被资产变体路由抢先匹配」），
  并在 `app.ts` 的注释里指向它。
- **中期（按需）**：只有在协议本身要调整时，才顺带把「变体名」从路径段里拿掉
  （如 `/api/assets/:id/variant/:variant?`），同步 `packages/protocol` 与前端调用方，旧路径保留过渡期。
  单为消除顺序依赖不值得做一次协议变更。

#### 理由

- 现有覆盖是顺带的，专门的用例让约束可读、可搜。
- 路径改形是协议 Breaking Change，收益只在消除一处已被测试守住的顺序依赖，不划算。

#### 影响面

短期：`apps/server/src/app.ts`（注释）、新增一条服务端用例。中期：`apps/server/src/assets/routes.ts`、
`apps/server/src/media-index/routes.ts`、`packages/protocol`、`apps/web` 调用方。

#### 风险

- 低（短期）；中（中期改路径）。

#### 验收

- 故意调换 `app.ts` 的挂载顺序 → 专门的路由顺序用例变红，失败信息说明原因。

---

### F. 数据访问约定

#### 现状证据

已有正规存储模块：`apps/server/src/runs/store.ts`（`JobStore`，440 行，作业/组/批次/决策/日志）、
`apps/server/src/library/store.ts`、`apps/server/src/assets/store.ts`、`apps/server/src/voices/store.ts`。

**12 个文件直接 import Drizzle**（排除上述 `store` 模块、schema 定义与生成代码）：
`agent/sessions.ts`、`agent/turn-store.ts`、`auth/index.ts`、`canvases/routes.ts`、
`projects/package.ts`、`projects/routes.ts`、`runs/impact.ts`、`storage/canvases.ts`、
`storage/previews.ts`、`subtitles/legacy.ts`、`sync/rooms.ts`、`templates/routes.ts`。

其中 `agent/turn-store.ts`（`TurnStore`）与 `storage/canvases.ts` 本身就是存储模块，直连是正当的；
需要判断的是其余 10 个。最明确该收的是 `apps/server/src/templates/routes.ts:59-61`——
**在路由工厂里直接 `db.insert(templates)`**，业务逻辑内联在 HTTP 处理器里。

#### 做法

- 先把「存储模块」的识别规则写清（文件名 `store.ts` / `*-store.ts` 或 `storage/` 目录），按规则归类，
  不以文件总数作为治理目标。
- 其余 10 个逐个判断：路由里的写操作进存储模块（如 `templates`、`canvases/routes`、`projects/routes`）；
  基础设施直连（如 `sync/rooms` 的房间状态、`auth`）明确标注并写清理由。
- 把约定写进 `CONTRIBUTING.md` 的「代码结构」一节。

#### 理由

- **直连本身不是罪，但「哪些能直连」没有约定，就是下一次迁移事故的来源**，尤其是跨表事务。
- **路由里直接写库是明确该收的**——换传输层（MCP / 能力层）就要重写一遍。

#### 影响面

`apps/server/src` 下 10 个文件 + `CONTRIBUTING.md`。

#### 风险

- **低。** 纯搬移，有服务端单测兜底。

#### 验收

- `CONTRIBUTING.md` 写明数据访问约定与存储模块的识别规则。
- `apps/server/src/**/routes.ts` 里不再出现直接的 Drizzle 写操作。

---

### G. 大文件拆分

#### 现状证据

非测试源文件里 1000 行以上的有 17 个（不含 `apps/server/bench/`），800 行以上的有 26 个：

| 文件                                                    | 行数 | 本轮处理                                                             |
| ------------------------------------------------------- | ---- | -------------------------------------------------------------------- |
| `apps/web/src/features/sequence/SequenceEditor.tsx`     | 2603 | 拆（见下）                                                           |
| `apps/server/src/runs/runs.ts`                          | 2569 | 复评：评审文档 §2.5 刚从 2776 行拆过一轮，先看剩余部分的职责边界再定 |
| `apps/web/src/features/storyboard/ShotWorkbench.tsx`    | 1911 | 拆                                                                   |
| `apps/web/src/features/library/Library.tsx`             | 1646 | 拆                                                                   |
| `apps/server/src/plugins/host.ts`                       | 1591 | 复评：与评审文档 §2.5 的拆分一并看                                   |
| `apps/web/src/features/library/LibraryProfile.tsx`      | 1376 | 拆                                                                   |
| `apps/web/src/features/stage/StagePanel.tsx`            | 1361 | 拆                                                                   |
| `apps/server/src/projects/package.ts`                   | 1339 | 拆                                                                   |
| `apps/server/src/agent/sessions.ts`                     | 1318 | 拆                                                                   |
| `apps/server/src/agent/tools.ts`                        | 1294 | 拆（与 D 同批）                                                      |
| `apps/web/src/features/agent/Agent.tsx`                 | 1277 | 跟踪                                                                 |
| `packages/doc/src/commands.ts`                          | 1136 | 由 B1 处理                                                           |
| `packages/providers/src/ark/index.ts`                   | 1135 | 跟踪                                                                 |
| `apps/web/src/features/runs/Tasks.tsx`                  | 1055 | 跟踪                                                                 |
| `apps/web/src/features/storyboard/StoryboardEditor.tsx` | 1048 | 跟踪                                                                 |
| `apps/web/src/features/settings/ProviderSettings.tsx`   | 1023 | 跟踪                                                                 |
| `packages/nodes/src/sequence.ts`                        | 1008 | 跟踪                                                                 |

本轮要拆的 8 个文件的内部结构：

| 文件                 | 内部结构                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SequenceEditor.tsx` | `Editor` 单组件 **1292 行**（`:350`–`:1641`）；`FilmSettings` 153、`ClipSettings` 273、`NumberField` 124、`SubtitleField` 77、`Volume` 88、`RequiredSecondsField` 79、`AnimaticSettings` 56 —— **都已是独立函数，只是挤在一个文件里**                                  |
| `ShotWorkbench.tsx`  | `Workbench` 单组件 **859 行**（`:130`–`:988`）；`ShotSummary`、`ShotComparison`、`SourceQuotes`、`ObservationSummary`、`CandidateInspection` 等均已独立                                                                                                                |
| `Library.tsx`        | `Editor` 760 行（`:805`–`:1564`）、`Panel` 400 余行（`:108` 起）、`Card` 193 行、`Hero` 82 行                                                                                                                                                                          |
| `LibraryProfile.tsx` | 11 个独立子组件，**全部挤在一个文件**，`useMemo`/`useCallback` 各 0 个                                                                                                                                                                                                 |
| `StagePanel.tsx`     | `StagePanel` 单组件 914 行，11 个 `useEffect`，`useMemo`/`useCallback` 各 0 个                                                                                                                                                                                         |
| `sessions.ts`        | `AgentSessions` **混了 7 件事**：会话 CRUD（`:156`–`:360`）、技能 CRUD（`:244`–`:265`）、MCP 服务端构造（`:865`）、CLI 传输驱动 `startDriver`（`:516`–`:609`）、内置模型回合 `startBuiltin`（`:697`–`:795`）、回合生命周期（`:486`–`:695`）、审批协商（`:610`–`:630`） |
| `tools.ts`           | 汇集各组能力集；`agentTools` 里有按名特判（见 D）                                                                                                                                                                                                                      |
| `package.ts`         | 导出（`:188`–`:630`）与导入（`:631`–`:1339`）两半挤在一个文件；模块级 `pending` map 在 `:645`                                                                                                                                                                          |

> 统计口径：`find apps packages -name '*.ts' -o -name '*.tsx'`，排除测试、`*.d.ts`、`node_modules`、`dist`、
> `apps/server/bench/`，按 `wc -l` 计。

#### 做法

- **前端**：按已有的独立函数切文件（`SequenceEditor` → `sequence/fields/*`、`sequence/FilmSettings.tsx` 等），
  再把超长组件按职责拆（`Editor` → 画布区 / 时间线 / 检查器三块）。
- **服务端**：`sessions.ts` → `session-state.ts`（状态机）+ `cli-driver.ts`（传输）+ `builtin-turn.ts`（模型回合）；
  `tools.ts` → `tools-media.ts` / `tools-runs.ts` / `tool-registry.ts`（注册与门禁）；
  `package.ts` → `package-export.ts` / `package-import.ts` / `package-staging.ts`。
- `runs.ts`、`host.ts` 先复评职责边界，确有独立职责再拆，不为行数硬拆。
- 拆分后同步更新 `import`，不改逻辑。

#### `runs.ts` / `host.ts` 复评结论

复评后两者都**本轮不拆**，理由不同。

**`runs/runs.ts`（2587 行）：职责已分好，剩下的是状态机本身。**

文件内已有清晰分区：`单节点`（`:483`）、`影响分析`（`:613`）、`批次快照`（`:682`）、`整组`（`:888`）、
`任务恢复`（`:1163`）、`队列与执行`（`:1577`）。

- `影响分析` 与 `批次快照` 两区已外移到 `runs/impact.ts`、`runs/batch.ts`，本文件只剩供它们复用的读取方法。
- `单节点`（`start` / `startChecked` / `preview` / `inspect` / `cachedCandidate` / `resultMatches` / `planKey`）
  与 `整组`（`runFlow` / `runBatch` / `runReviewedBatch` / `runImpact` / `runGroup`）是两套入口编排，
  但共用同一套队列、缓存键与执行体（`execute` / `runOnce` / `prepare` / `cacheKey` / `collectInputs`）。
- `任务恢复`（`recoverJob` / `resume` / `recover`）与 `队列与执行` 共享 `ActiveJob`、`this.store` 与
  `enqueue`/`pump` 状态，不是可独立搬走的纯函数。

唯一自包含的职责是「缓存键计算」（`cacheKey` / `keyMatches` / `legacyCacheKey` / `latestParams` / `hashKey` /
`cacheParams`，约 100 行），可搬到 `runs/cache-key.ts`。它不只依赖 `Prepared` 与元素：`resolveModel` 读宿主
注册表、键里还带渲染器身份，搬走时要把模型版本、插件版本与渲染器身份作为参数显式传入。它同时被
`runs/impact.ts`、`runs/batch.ts` 与本文件的 `cachedCandidate` / `resultMatches` 使用，
搬走要同时改三处调用方，收益与改动面不成比例。

结论：**可拆但不值得**。触发条件：缓存键逻辑再长（超过 200 行）或出现第二个消费方时，先拆 `cache-key.ts`。

**`plugins/host.ts`（1591 行）：边界在「平台」而非行数。**

分区只有三段：`Provider`（`:172`–`:1127`，956 行）、`节点执行`（`:1128`–`:1392`，265 行）、`内部`（`:1393` 起）。

- `Provider` 区自己又分两类：远端模型目录（`remoteModelsStatus` / `mergedModels` / `refreshRemoteModels` /
  `models` / `defaultModel`，`:172`–`:312`）与平台能力调用（`testProvider` / `voiceClone` / `cloneVoice` /
  `voiceDesign` / `designVoice` / `voiceStatus` / `services`，`:313`–`:1127`）。
- `节点执行` 区（`runNode` / `verifySubmit` / `providerContext` / `storeOutputs` / `compose` /
  `renderComposition`）与 `Provider` 区共享 `this.limiter`（限流）、`this.configs`（凭据）、
  `this.registry`（插件注册表）三处状态，且 `runNode` 内部直接调用 `providerContext`。

「远端模型目录」是相对独立的一块（不碰限流与执行体），约 140 行。除 `this.remoteCache` 与 `this.configs` 外，
它还依赖注册表刷新、`remoteGenerations` / `remotePulling` 两份并发状态与 `providerContext` 凭据上下文，
搬走时要一并保留这些并发控制与凭据传递。可搬到 `plugins/remote-models.ts`。但它对外是 `PluginHost` 的公开方法，而 `PluginHost` 被 15 个服务端文件引用
（含 `agent/tool-registry.ts`、`agent/plugin-caps.ts`、`runs/models.ts` 等），搬走要保留转发方法，多一层间接。

结论：**同样可拆但不值得**，收益比 `runs.ts` 更小。

两者的共同问题不是「文件大」，而是「外部依赖面宽」：`PluginHost` 被 15 个服务端文件引用，`NodeRuns` 被 6 个引用
（含 `app.ts` 的构造点）。依赖面不变的前提下拆文件，只会让评审者多跳几个文件。

建议：把 `runs.ts` / `host.ts` 列为「跟踪」项，等具体职责自然长大或出现第二个消费方时，按当时的实际边界拆。

#### 理由

- **这里的函数边界已经存在，只是没跨文件。** 把已独立的组件移到各自文件是零逻辑改动的纯搬移。
- **冲突面比需要的大。** 2603 行的文件里同时住着「时间线渲染」和「数字输入框」。
- **评审成本。** 859 行的 `Workbench` 组件很难在 diff 里看清改了什么。

#### 影响面

本轮要拆的 8 个文件及其 import 方。

#### 风险

- **低**（纯搬移）；**中**（拆组件，涉及 props 与状态归属）。
- 回归保护：`SequenceEditor.test.tsx`（893 行）、`ShotWorkbench.test.tsx`（1505 行）、
  `LibraryProfile.test.tsx`（760 行）、服务端 `runs` / `agent` 各有 40 / 16 个测试文件。

#### 验收

- 本轮要拆的 8 个文件每个不超过 800 行，其中的组件不超过 400 行。
- 全仓超过 800 行的文件数作为递减式指标（当前 26），新文件不得超过 800 行。
- 拆分前后测试全绿，行为不变。

---

### H. Zustand 订阅选择器化

#### 现状证据

zustand v5 的 `useStore()` 不带 selector 时，**store 里任何字段变化都会触发重渲染**。
`apps/web/src` 里的 17 个 Zustand store hook（含 4 个 `createPendingSetStore()` 产物）中，无参全量订阅有 11 处：

| 位置                                                    | 订阅内容                  |
| ------------------------------------------------------- | ------------------------- |
| `apps/web/src/shell/Sidebar.tsx:162`                    | `useLibrary()` → 5 个字段 |
| `apps/web/src/shell/Sidebar.tsx:773`                    | `useLibrary()` → 7 个字段 |
| `apps/web/src/features/library/Library.tsx:109`         | `useLibrary()` → 7 个字段 |
| `apps/web/src/features/library/Library.tsx:834`         | `useLibrary()` 全量       |
| `apps/web/src/features/settings/Settings.tsx:36`        | `useCatalog()`            |
| `apps/web/src/features/onboarding/WelcomeDialog.tsx:20` | `useCatalog()`            |
| `apps/web/src/features/onboarding/Welcome.tsx:31`       | `useCatalog()`            |
| `apps/web/src/shell/Sidebar.tsx:50`                     | `useSidebar()`            |
| `apps/web/src/App.tsx:160`                              | `useSession()`            |
| `apps/web/src/shell/DesktopUpdates.tsx:79`              | `useUpdate()`             |
| `apps/web/src/shell/DesktopUpdates.tsx:184`             | `useUpdate()`             |

`useVoices()`（`apps/web/src/features/library/voices.ts:10`）是 React Query，不在此列。

`useLibrary` 的 store（`apps/web/src/features/library/store.ts:65`）有 9 个独立状态字段
（`items` / `loaded` / `loading` / `error` / `open` / `seed` / `focus` / `tab` / `projectId`），
侧栏只关心其中几个，却会随其余字段（如加载状态、打开的面板）变化而重渲染。

对照：`apps/web/src/features/motion/MotionPanel.tsx:142`、`apps/web/src/features/generator/Generator.tsx:279`、
`apps/web/src/features/runs/Tasks.tsx:394` 已经用了选择器（`useRunRequests((s) => s.pending.has(key))`），
说明项目里已有正确写法。

#### 做法

- 这 11 处改成带选择器的订阅；取多个字段时用 zustand v5 的 `useShallow`。

#### 理由

- **全量订阅把「关心什么」和「关心多少」混为一谈。**
- **`useShallow` 是 zustand v5 的标准解法**，不需要自己写 memo，也不引新依赖。

#### 影响面

上表 11 处调用点。

#### 风险

- **低。** 纯订阅粒度调整；但要小心别把 selector 写成每次返回新对象（那样反而更糟），
  所以多字段场景必须配 `useShallow`。

#### 验收

- 上述 store hook 的无参调用清零；检查脚本按 `create(...)` 与 `createPendingSetStore()` 导出的 hook 名单匹配，不泛指所有 `useXxx()`，
  与本项同批落地。
- 用 React DevTools Profiler 记录一次资产库加载，侧栏只在它订阅的字段变化时重渲染。

---

### I. 前端依赖与组件复用

#### 约定

前端开发遵循四条：**优先复用成熟库、组件源代码可控、统一设计语言、严格限制重复依赖**。
已有依赖能正确表达的组件和行为，**不自行设计实现**。各用途的选型：

| 用途         | 选型                                       | 现状                                                                                                       |
| ------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 无样式组件层 | Base UI（`@base-ui/react`）                | 已采用，`apps/web/src/ui/*` 封装；目前只用到 dialog / menu / popover / select / switch                     |
| 组件组织     | shadcn/ui：源码进仓库、自己维护            | `ui/*` 已是这种形态；按 `base-nova` 配置（Base UI 底层 + Nova 风格）引入组件源码，放在 `apps/web/src/ui/`  |
| 视觉风格     | shadcn/ui Nova                             | 待迁移；Nova 的数值落进 `tokens.css`，令牌仍是唯一数值来源，见 I5                                          |
| 图标         | Lucide（`lucide`）                         | 已采用，统一走 `ui/icons.tsx`；画布覆盖层不走 React，所以用原生包 + `iconElement()`，不另装 `lucide-react` |
| 动画         | Motion（`motion`）+ CSS 令牌               | 待引入；退场、布局与手势动画用 Motion，简单过渡仍用 Tailwind 令牌，见 I6                                   |
| 可调面板     | react-resizable-panels                     | 未引入；侧栏拖宽为手写                                                                                     |
| 列表拖拽排序 | dnd-kit                                    | 未引入；参考图排序为原生 HTML5 拖拽                                                                        |
| 状态管理     | Zustand（本地）+ React Query（服务端数据） | 已采用                                                                                                     |
| 样式         | Tailwind v4 + `tokens.css`                 | 已采用                                                                                                     |

#### 现状证据：已有依赖能表达却自己写的地方

- **原生 `<select>` 54 处，分布在 22 个文件**，而 `apps/web/src/ui/Select.tsx:15` 自述就是「替代原生 select，
  弹层与应用里其他菜单一致」。例：`apps/web/src/shell/Viewer.tsx:306,325`。
- **原生 `type="range"` 19 处**，Base UI 有 Slider，可统一键盘操作、焦点与令牌样式。
- **`apps/web/src/ui/Tooltip.tsx` 204 行手写**（全局接管 `title`、自建定位与延迟），Base UI 有 Tooltip。
  全局接管 `title` 的行为要保留的话，用 Base UI Tooltip 做气泡、只保留接管逻辑。
- **`apps/web/src/ui/Presence.tsx` 92 行手写退场动画**（保留内容、标 `data-closing`、等动画播完再卸载），
  这正是 Motion `AnimatePresence` 的职责。
- **侧栏拖宽 `apps/web/src/shell/sidebarResize.ts` 52 行手写**（指针捕获、取消恢复），
  样式在 `apps/web/src/styles/editor.css:280-309`，是 react-resizable-panels 的直接场景。
- **参考图排序 `apps/web/src/features/generator/Inputs.tsx:246-249`** 用原生 HTML5 拖拽，没有键盘可达的排序方式，
  是 dnd-kit 的直接场景；序列时间线的片段拖动（`apps/web/src/features/sequence/Timeline.tsx:848`）可一并评估。
- **不适用的场景**，避免过度替换：画布指针交互（`CanvasView`、`Board`、`Minimap`、`Viewer`、`MaskEditor`、
  `canvas/player.ts`）由 canvas-core 处理；文件拖入上传（`LibraryFields.tsx:266`、`LibraryProfile.tsx:1127`、
  `CharacterAssets.tsx:328`）只需 `onDrop`；时间线裁剪与拖动播放头是时间轴专属交互。

#### 现状证据：依赖版本

- `yjs` 在 `apps/web`、`apps/server`、`packages/doc`、`packages/capabilities` 各声明一次（`^13.6.33`）；
  Yjs 多实例会破坏 `instanceof` 判断，是最需要钉成单版本的依赖。
- `zod` 在 6 个包里各声明一次（`4.6.7`）。
- `pnpm-workspace.yaml` 的 `catalog:` 目前只收了 `vite` / `vite-plus`。

#### 做法

- **I1 — 收敛到已有依赖（不加新包）**：原生 `<select>` 换 `ui/Select.tsx`；原生滑块换 Base UI Slider，
  封装进 `ui/`；`ui/Tooltip.tsx` 改用 Base UI Tooltip。
- **I2 — 引入专用库替换手写行为**：侧栏换 react-resizable-panels；参考图排序换 dnd-kit（`@dnd-kit/core` +
  `@dnd-kit/sortable`）。两者都按需加载，不进首页首屏。
- **I3 — 依赖单一来源**：跨包共用的依赖（`yjs`、`zod`、`react`、`zustand` 等）进 `pnpm-workspace.yaml`
  的 `catalog:`，各包写 `catalog:`；`verify` 里加 `pnpm dedupe --check`，锁文件里出现可合并的重复版本即失败。
- **I4 — 写进约定**：`docs/dev/design-spec.md` 的组件一节补上本节的选型表；`CONTRIBUTING.md` 写明
  「新增前端依赖前先查选型表，同一用途不引第二个库」。
- **I5 — 视觉风格统一到 Nova**：
  - 在 `apps/web` 加 `components.json`，风格设为 `base-nova`（Base UI 底层），组件生成到 `src/ui/`；
    图标改走 `ui/icons.tsx`，不引入 `lucide-react`。
  - 把 Nova 的间距、控件高度、圆角、阴影、字号逐项对照现有 `tokens.css`，**改令牌而不是改组件**：
    令牌仍是唯一数值来源，`design-spec.md` 里「不写任意值」的规则不变。
  - `ui/*` 里已有的控件按 Nova 组件源码重建，保留现有的封装接口，调用方不动；
    `styles/controls.css` 的通用控件类随之收缩，只留 Nova 组件覆盖不到的部分。
  - shadcn/ui 组件依赖 `cn()` 合并类名。CLI 默认生成的是 shadcn 自家的 `cn` 包，这里改用 `clsx` + `tailwind-merge`
    （以及部分组件用的 `class-variance-authority`）：`extendTailwindMerge` 能登记 `shadow-1..4`、`text-2xs` 这类自定义工具类，
    避免合并时误删。纳入 I3 的单一来源管理；`tw-animate-css` 与 `shadcn/tailwind.css` 不引入，进退场仍用现有写法。
  - Nova 源码里的语义类（`bg-muted`、`bg-popover`、`border-input` 等）翻译成现有令牌类，不加 shadcn 变量别名：
    shadcn 的 `--accent` 是悬停灰，与这里表示选中的蓝色 `--accent` 同名不同义。
  - 只改界面外壳；画布里的作品、节点卡片配色不随风格变化（`design-spec.md`「颜色留给画布里的作品」）。
  - 同步改写 `docs/dev/design-spec.md` 的尺寸、圆角、控件各节，以 Nova 为基准。
- **I6 — 动画统一到 Motion**：
  - 引入 `motion`，用 `LazyMotion` + `m` 组件按需加载动画特性，不进首页首屏。
  - `ui/Presence.tsx` 的手写退场换成 `AnimatePresence`；`useExit()` 的调用方改为 Motion 的 `exit` 声明，
    浮层收起途中不响应指针、Esc 和点外面的约定保留。
  - 进退场的位移、缩放、时长、曲线仍由令牌定义（`--pop-from` / `--pop-to` / `--pop-origin` 改成 Motion 的变体参数），
    `design-spec.md` 的动效一节按 Motion 改写。
  - 减少动态效果：用 Motion 的 `MotionConfig reducedMotion="user"` 统一处理，替代 `styles/motion.css` 里对退场的特殊分支；
    该文件对 CSS 过渡的压缩保留。
  - Base UI 自己管理挂载的下拉与菜单（`data-ending-style`）先保持 CSS 动画，避免两套挂载逻辑打架。

#### 理由

- **自己写的交互组件，每个都要单独解决键盘、焦点、ARIA、定位与减少动态效果**，成熟库已经解决过。
  `design-spec.md:180` 已经写了「先找 Base UI」，缺的是把存量收拢和把规则扩展到拖拽、面板、动画。
- **重复依赖是隐性故障源**：Yjs 多实例、两份图标包、两套动画方案，都会在体积和行为上同时付出代价。

#### 影响面

`apps/web/src/ui/*`、22 个含原生 `<select>` 的文件、含原生滑块的文件、`shell/sidebarResize.ts` 与 `Sidebar.tsx`、
`features/generator/Inputs.tsx`、`pnpm-workspace.yaml` 与各包 `package.json`、`docs/dev/design-spec.md`、`CONTRIBUTING.md`。

#### 风险

- I1 **低**：换成 I5 重建后的控件，样式由令牌统一。注意 `Select` 与原生 `<select>` 在测试里的查询方式不同，用例要跟着改。
- I2 **中**：侧栏宽度偏好要迁移到新库的存储方式；拖拽排序要保留撤销分组（`reorderInputs` 的事务语义）。
- I6 **中**：退场时序变化可能影响依赖 `data-closing` 的用例与 e2e；先替换 `Presence` 一处、跑通再推开。
- I3 **低**：只改版本声明方式，锁文件解析结果应不变。
- I5 **中**：全局视觉变化，所有界面都会受影响。先改令牌、再重建控件，每一步都在浅色 / 深色、
  减少动态效果三种条件下走查；涉及界面截图的 e2e 用例要同步更新基线。

#### 验收

- `apps/web/src` 非测试代码里原生 `<select>` 与 `type="range"` 清零。
- `ui/Tooltip.tsx`、`shell/sidebarResize.ts` 的手写定位与指针捕获逻辑删除。
- `pnpm dedupe --check` 通过并进入 `verify`；`yjs`、`zod` 全仓只解析出一个版本。
- 首页首屏 gzip 仍在门禁内，新引入的库不出现在首屏 chunk。
- `ui/Presence.tsx` 删除，退场统一由 `AnimatePresence` 负责；开启减少动态效果时退场直接卸载。
- `components.json` 的风格为 `base-nova`；`ui/*` 的控件来自 Nova 组件源码；`design-spec.md` 已按 Nova 改写，
  组件里仍没有任意值。

---

## 4. 初步实施方案

分阶段，**每阶段结束必须满足「全绿 + 可回滚」**。

状态列随实施更新；1.2 只完成前端部分，服务端拆分在 2.3，其中 `tools.ts` 已随 2.1 拆完。

### 阶段 0：护栏（半天）

| 项  | 内容                                                                                                 | 理由                         | 状态   |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------- | ------ |
| 0.1 | `CONTRIBUTING.md` 代码结构一节写入：元素类型注册、能力审批、路由顺序、数据访问、前端依赖选型五条约定 | 让新代码有据可依             | 已完成 |
| 0.2 | 依赖单一来源：跨包依赖进 `catalog:`，`verify` 加 `pnpm dedupe --check`                               | I3；只改声明方式，不必然变红 | 已完成 |

需要代码先改好才能通过的门禁（每个 kind 必须有渲染器、Zustand 无参订阅清零、原生 `<select>` 清零）
**与对应修复同批落地**，不放在阶段 0。

### 阶段 1：低风险收敛（1–2 周）

| 项  | 内容                                                                                                            | 对应            | 状态   |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------- | ------ |
| 1.1 | 删 `sequence` kind 与死分支、修 plugin-sdk 注释、节点工厂合并或钉住；同批加「每个 kind 必须有渲染器」的类型约束 | A1              | 已完成 |
| 1.2 | 8 个大文件按已有函数边界切文件                                                                                  | G（纯搬移部分） | 已完成 |
| 1.3 | 11 处全量订阅改选择器，同批加检查                                                                               | H               | 已完成 |
| 1.4 | `commands.ts` 拆出 `commands/sequence.ts`，领域记录挪进 `src/domain/`                                           | B1              | 已完成 |
| 1.5 | `production.selection` → `production.target` + 架构文档补例外                                                   | C1              | 已完成 |
| 1.6 | 路由顺序专门用例                                                                                                | E（短期）       | 已完成 |
| 1.7 | Nova 基线：`components.json`、令牌对齐、`ui/*` 控件按 Nova 重建、改写设计规范                                   | I5              | 已完成 |
| 1.8 | 原生 `<select>` / 滑块 / Tooltip 收敛到 Nova 控件，同批加检查                                                   | I1              | 已完成 |

**理由**：全部是低风险、可用现有单测充分回归的改动，先把地基清干净。

### 阶段 2：机制声明化（2–3 周）

| 项  | 内容                                                                                  | 对应            | 状态   |
| --- | ------------------------------------------------------------------------------------- | --------------- | ------ |
| 2.1 | 能力增加审批说明与执行前流程声明，调度器与审批去掉按名特判                            | D               | 已完成 |
| 2.2 | 10 个直连文件分类，路由里的写操作收进存储模块                                         | F               | 已完成 |
| 2.3 | `sessions.ts` / `tools.ts` / `package.ts` 拆分；复评 `runs.ts` / `host.ts`            | G（服务端部分） | 已完成 |
| 2.4 | 前端节点注册表、`RendererRegistry` 支持 nodeType、编辑器表驱动、删 `catalog.elements` | A2、A3          | 已完成 |
| 2.5 | 侧栏换 react-resizable-panels、参考图排序换 dnd-kit                                   | I2              | 未开始 |
| 2.6 | 引入 Motion，`Presence` 换 `AnimatePresence`，改写动效规范                            | I6              | 未开始 |

**理由**：D 是「能力系统兑现承诺」的一步；`tools.ts` 的拆分与 D 同批，避免同一文件改两遍。
A2 / A3 只依赖 A1，不依赖 B。

### 阶段 3：按需（有触发条件再做）

| 项  | 内容                                                             | 触发条件                       |
| --- | ---------------------------------------------------------------- | ------------------------------ |
| 3.1 | 建 `packages/domain`，分批迁移领域模型与纯函数                   | 出现第二个需要领域推导的消费方 |
| 3.2 | `/api/assets/:id/variant/:variant?` 改路径形状，兼容旧路径过渡期 | 资产协议本身要调整             |
| 3.3 | 按 0.1 的约定复查全仓                                            | 阶段 2 完成后                  |

### 关键路径与依赖

```text
阶段 0 ──▶ 阶段 1 ──▶ 阶段 2 ──▶ 阶段 3（按需）

A1 ──▶ A2 ──▶ A3
C1 ──▶ B2（3.1）
I5 ──▶ I1
D  ──  G 的 tools.ts 拆分同批
```

- **A1 无前置**，越早做越好：错误注释每多存活一阶段，就多误导一批插件开发者。
- **C1 先于 B2**：改名前 `production.selection` 的语义有歧义，领域迁移时不知道该把它当领域字段还是运行时字段。
- **A 与 B 互不依赖**：渲染键与编辑器分发不读领域字段。
- **I5 先于 I1**：原生控件直接换成 Nova 控件，避免先换成旧样式再改一遍。
- **F、H、I 与 A–E 无依赖**，可与任何阶段并行。

## 5. 明确不做的事

写下来是为了避免以后有人「顺手」做：

| 不做                                                | 理由                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 把 `protocol` 与 `nodes` 的资产库 schema 合并成一份 | 两边不互相依赖是**有意的**（协议包要能独立校验请求）。已用契约测试 [apps/server/src/library/library-schema-parity.test.ts](../../apps/server/src/library/library-schema-parity.test.ts) 把两边钉在一起：任一边改上限而另一边没改，用例立刻变红。 |
| 把 `providers` 的语音实现合并                       | 核对过：`packages/providers/src/ark/plan-speech.ts`（169 行）是 **ASR**，走 WebSocket；`packages/providers/src/doubao/index.ts:390` 的 `synthesizeSpeech` 是 **TTS**，走 HTTP。两者是同厂商的不同产品线，不是重复实现。                          |
| 给 `packages/flow` 加回 `stableStringify`           | 已独立成 `@plein/canonical`。工作流引擎不该是通用工具的宿主。                                                                                                                                                                                    |
| 把 `production.selection` 迁出文档（完整版）        | 需要引入第二套跨端同步机制，与「文档是唯一事实来源」冲突。见 C2 的分析。                                                                                                                                                                         |
| 在 `doc` 里给领域逻辑加 DAO                         | `doc` 是文档模型，不是数据访问层。                                                                                                                                                                                                               |
| 一次性重写 `packages/doc`                           | 影响面太大，收益不匹配。按 B1 包内切分，B2 按需。                                                                                                                                                                                                |
| 把 catalog 当成渲染器与编辑器的来源                 | catalog 是可序列化的 HTTP 数据；可执行的渲染能力在前端注册表登记，第三方的走沙箱。                                                                                                                                                               |
| 把画布指针交互、文件拖入换成 dnd-kit                | 画布交互由 canvas-core 负责，文件拖入只需 `onDrop`，都不是列表排序场景。                                                                                                                                                                         |
| 另装 `lucide-react`                                 | 画布覆盖层也要用同一套图标，原生 `lucide` + `ui/icons.tsx` 已覆盖两端；引入组件源码时把图标改走 `ui/icons.tsx`。                                                                                                                                 |
| 为消除路由顺序依赖单独改协议                        | 已有测试守住，改路径是 Breaking Change，收益不匹配。                                                                                                                                                                                             |

## 6. 怎么验证

每一步都跑：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build        # 含首页首屏 gzip 门禁（当前 173.15 KiB / 门禁 300 KiB）
```

推送前 `pnpm verify` 跑完整检查。文件数与用例数以命令输出为准，不在文档里手抄。

跨包迁移（B2）和改动文档数据形状的项，额外要跑：

```bash
pnpm --filter @plein/desktop test:profile   # 桌面端档案
pnpm --filter @plein/desktop test:update-feed
pnpm test:e2e-lifecycle                      # 服务端生命周期契约
pnpm e2e                                    # 完整 e2e（本地跑）
```

引入新前端依赖的项（I2、I6）额外核对首页首屏 chunk 不含新库。

## 7. 关联文档

- [架构规划](../dev/architecture.md) —— 方向与原则
- [代码结构与架构评审](../dev/architecture-review.md) —— 2026-11-02 已落地的收敛与依据
- [设计规范](../dev/design-spec.md) —— 令牌、控件与动效
- [功能规划](feature-plan.md) —— 功能排期与取舍
- [插件](../dev/plugins.md) —— 插件 API 与隔离边界
- [贡献指南](../../CONTRIBUTING.md) —— 代码结构与提交约定
