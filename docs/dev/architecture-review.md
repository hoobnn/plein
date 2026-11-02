# 代码结构与架构评审

2026-11-02 · hoobnn

本文是对当前代码库的一次结构梳理与优化记录：先给依赖与分层的现状判断，再列本轮实际改动，
最后留下仍需产品／架构决策的事项。与 [架构规划](architecture.md) 的关系是：那篇讲方向与原则，
这篇讲当下代码的真实形状与本轮收敛结果。

## 一、总体判断

先说结论：这个项目的**工程质量明显高于平均水平的同类项目**——依赖方向没有反向引用、类型层面
零 `any`、零 `@ts-ignore`、零 TODO 标记、1382 个文件 lint 全绿、4452 个单测覆盖着协议与领域模型。
真正的问题不在「写错了什么」，而在**几处结构性的债**：分层在个别地方被绕过、大文件承担了过多职责、
同一个概念存在两份实现。

| 维度       | 现状                                                     | 判断   |
| ---------- | -------------------------------------------------------- | ------ |
| 依赖方向   | 修复后 packages 形成严格 DAG，无反向、无环               | 良好   |
| 类型安全   | 0 个 `any`、0 个 `@ts-ignore`、0 个 `@ts-expect-error`   | 优秀   |
| 测试       | 571 个文件 / 4460 个用例，覆盖协议、领域模型、渲染、集成 | 优秀   |
| 提交门禁   | pre-commit 跑 staged 检查，pre-push 跑完整 `verify`      | 良好   |
| 文件体量   | 仍有 5 个 1300–2600 行的文件                             | 待收敛 |
| 概念唯一性 | 资产库、序列片段等概念在两个包里各有一份实现             | 待收敛 |
| 注册机制   | 元素类型分散在 4 套互不相通的机制里                      | 待收敛 |

## 二、本轮实际改动

### 2.1 分层修复

**`capabilities → protocol` 这条越界边已删除。** 能力层此前为了读一个 `Catalog` 类型而依赖接口
协议包；协议包一旦反向引用能力层就会成环。`Catalog` 说的就是「插件注册了什么」，本属插件公开 API，
因此下沉到 `@plein/plugin-sdk`（[packages/plugin-sdk/src/catalog.ts](../../packages/plugin-sdk/src/catalog.ts)），
`@plein/protocol` 继续转出去，**调用方一行不用改**。能力层因此只依赖 doc / nodes / plugin-sdk。

**`packages/flow` 不再兼职通用工具库。** `stableStringify`（稳定序列化，用来算缓存键与摘要）原本
住在 `packages/flow/src/key.ts`，而 `flow` 自己根本不用它；字幕、插件清单、批次快照这些跟工作流
毫无关系的模块却都从工作流引擎包里引它。现在它是独立叶子包
[packages/canonical](../../packages/canonical)，依赖图为零。

修复后的 packages 依赖矩阵（箭头只向下）：

```text
@plein/canonical   → （无）
@plein/plugin-sdk  → （无）
@plein/flow        → （无）
@plein/doc         → plugin-sdk/ports
@plein/nodes       → plugin-sdk
@plein/providers   → plugin-sdk
@plein/protocol    → plugin-sdk
@plein/canvas-core → doc
@plein/capabilities→ doc · nodes · plugin-sdk
```

`apps/*` 之间仍然互不 import，桌面端只经子进程与 `protocol` 交互。

### 2.2 打包体积

8 个 packages 全部没有声明 `sideEffects`，打包器只能保守假设每个模块都有副作用，**根桶文件里的
未使用导出无法被摇掉**——而全仓有 422 个文件从 `@plein/doc` 根桶导入。逐个核对确认这些包在模块
作用域内确实没有副作用（`defineCapability` 只做校验后返回、zod 构造器是纯函数、
`window.addEventListener` 都在函数体内），于是补上 `"sideEffects": false`。

首页首屏 JS gzip：**184.46 KiB → 173.15 KiB（-11.31 KiB，-6.1%）**，chunk 数 22 → 16，
离 300 KiB 的门禁更宽裕。

### 2.3 前端 API 层收成一份

此前有 4 套并行请求实现：`api/client.ts`、媒体库、检查点、维护接口、插件安装各自写了一遍
`fetch` + 错误处理。新增 [apps/web/src/api/http.ts](../../apps/web/src/api/http.ts) 作为唯一传输层，
其余全部改为复用它。顺带修掉一个**真实缺陷**：维护接口与插件安装两个客户端没有处理 401，
会话失效时不会回登录页，用户只会看到一个无声的失败。

网络错误提示也统一了：离线与「连不上本地服务」现在分开说，原异常保留在 `cause` 里。

### 2.4 渲染热路径

`SequenceEditor` 的 `readSequence()` 每次渲染都要遍历上游图、排序列、校验节点，而组件还因为
选中、播放头、展开、拖拽草稿等本地状态频繁重渲染。现在按文档版本 memo，
「文档没变就不重算」；`packKey`、`interactionKey` 两处全量 JSON 序列化也随之收敛。
配套把 `useAssetMetas` 的 `get` 改成稳定引用，并暴露出 `revision`（已知素材集合变化时递增），
让依赖素材时长的 memo 有正确的失效信号。

窗口级快捷键此前用「无依赖数组的 `useEffect`」，每次渲染都摘下再挂上监听器。抽成
[useWindowKeyDown](../../apps/web/src/ui/useWindowKeyDown.ts)（沿用项目里已有的 latest-ref 写法），
监听器只注册一次。

三份逐字重复的 pending-set store（提交 / 取消 / 恢复）收成一个工厂
[stores/pendingSet.ts](../../apps/web/src/stores/pendingSet.ts)。

### 2.5 服务端大文件拆分

| 文件                              | 前   | 后   | 拆出                                                                                |
| --------------------------------- | ---- | ---- | ----------------------------------------------------------------------------------- |
| `apps/server/src/runs/runs.ts`    | 2776 | 2563 | `runs/graph.ts`（依赖图与端口值换算）、`runs/frozen.ts`（冻结参数、调用证据与校验） |
| `apps/server/src/plugins/host.ts` | 1817 | 1591 | `plugins/provider-protocol.ts`（错误分级、调用记录、结果内嵌与恢复判据）            |

`provider-protocol.ts` 值得单独说：任务恢复、字幕配额、智能体工具都要读同一份「这次调用算不算
已受理、密钥有没有换、结果能不能复用」的判据，这些判据此前埋在宿主类里，现在有了自己的家。

### 2.6 重复 schema 的防漂移

`@plein/protocol` 与 `@plein/nodes` 各有一份同构的资产库 schema（`LibraryKind` /
`LibraryProfile` / `LibrarySceneView` 对 `LibraryKindId` / `CharacterProfile` / `SceneView`）。
两边不互相依赖是**有意为之**（协议包要能独立校验请求），所以没有强行合并，而是加了一条契约测试
[library-schema-parity.test.ts](../../apps/server/src/library/library-schema-parity.test.ts) 把两边的
字段上限与约束钉在一起——任一边改了上限而另一边没改，用例立刻变红。已验证：把 `expressions`
上限从 24 改成 32，测试如期失败。

## 三、仍待决策的事项

这几条我没有擅自改动，因为它们要么影响数据模型，要么需要产品判断。

### 3.1 `production.selection` 写进了 Yjs 文档

架构文档明文规定「运行时状态（执行进度、选中、悬停）不进文档」，而
`packages/doc/src/production.ts` 的 `selectProductionTarget()` 把**当前聚焦的镜头／序列 id**
写进了共享文档，参与撤销栈与协同同步。

**复查后更正**：它不是漏网的运行时状态，而是**有意的共享指针**——
`packages/capabilities/src/production.ts:70` 的 `edit_production` 能力（`op.action === 'select'`
分支）会写它，而该能力注册在 `apps/server/src/agent/tools.ts:1073` 的 `serverCapabilities` 里，
**内置智能体与 MCP 都能改它**。用户与智能体共享同一个「当前制作目标」，因此它必须能被服务端写、
必须持久化、必须让协作者看见。

服务端**不读**这个字段（`apps/server/src` 里没有读取点），读的 6 处全在前端
（`apps/web/src/features/creation-guide/*` 与 `apps/web/src/features/storyboard/ShotWorkbench.tsx:168`）。

所以这里的问题不是代码违规，而是**名字在骗人**：`selection` 让人以为是漏网的运行时状态，
于是一直被当成待办挂着。正确做法是改名为 `production.target` 并在架构文档里写明这条例外，
而不是迁出文档——迁出去需要引入第二套跨端同步机制，与「文档是唯一事实来源」直接冲突。

详细的分析与取舍见[架构调整方案](../plan/architecture-refactor-plan.md)的 C 项。

### 3.2 元素类型有 4 套注册机制

架构文档要求「doc schema + 渲染器 + DOM 编辑器 + flow node 共用同一套注册机制」，实际是：

- `packages/doc/src/types.ts` 的 `ElementKind` 固定 7 个 kind；
- `packages/plugin-sdk` 的 `defineElementType` 供插件声明自定义元素，但 `doc` / `canvas-core`
  里没有任何 `'custom'` 分支处理——插件声明的元素前端并不上屏；
- `packages/canvas-core` 的 `RendererRegistry` 按 `ElementKind` 注册，所有节点共用一个泛型
  `nodeRenderer`，没有按 `nodeType` 注册；
- DOM 编辑器没有注册表，是散落的 `if`（`ResultBar.tsx`、`CanvasMenus.tsx` 逐个比较 `nodeType`）。

复查补证两点：

- `packages/plugin-sdk/src/contributions.ts:72` 的注释写着「文档里存为 `kind: 'custom'` +
  `customType`」，但 `'custom'` **不在** `ElementKind` 里，`CanvasElement` 上也没有 `customType`
  字段——注释与现实不符。
- 代价可量化：生产代码里比较 `.kind` 与 kind 字面量共 324 处（其中 154 处是元素专属 kind，
  分布在 67 个文件），比较 `nodeType` 字面量 104 处（53 个文件）。
  **加一种内置元素类型要同时改 4 个地方，漏一处就是静默错误。**

顺带一个具体缺陷：`ElementKind` 里的 `'sequence'` 从来没有生产代码创建（序列实际是
`kind: 'node'` + `nodeType: 'plein/sequence'`），`RendererRegistry` 也没注册它，一旦出现就静默
降级成占位卡片。要么给它注册渲染器，要么从类型联合里删掉（后者需要一条迁移）。

方案与取舍见[架构调整方案](../plan/architecture-refactor-plan.md)的 A 项。

### 3.3 `packages/doc` 承担了领域逻辑

`CanvasElement` 上挂着 `reviews?` / `production?` / `deliveries?`，`packages/doc/src/commands.ts`
1136 行里有 344 行是序列专属命令。领域记录因此无法从文档层迁出，而 `doc` 又必须保持框架无关。

量化：`packages/doc` 非测试 5697 行里，领域模块（continuity / source-map / production /
sequence-instances / production-goal / delivery / shotGroup / video-segment / reviews）占 2693 行，
约 47.3%。方案见[架构调整方案](../plan/architecture-refactor-plan.md)的 B 项。

### 3.4 其余仍偏大的文件

`apps/web/src/features/sequence/SequenceEditor.tsx`（2603）、`storyboard/ShotWorkbench.tsx`（1911）、
`library/Library.tsx`（1646）、`library/LibraryProfile.tsx`（1376）、`stage/StagePanel.tsx`（1361）、
`apps/server/src/agent/sessions.ts`（1318）、`apps/server/src/agent/tools.ts`（1294）、
`apps/server/src/projects/package.ts`（1339）。

好消息是拆分缝已经存在：`SequenceEditor.tsx` 里 `FilmSettings`、`ClipSettings`、`NumberField`
等 7 个组件都已是独立函数，只需跨文件搬移；`ShotWorkbench.tsx` 里 `Workbench` 单组件 859 行，
子组件也已独立。方案见[架构调整方案](../plan/architecture-refactor-plan.md)的 G 项。

## 四、还没做的结构调整

本文记录的是**已经落地**的收敛。尚未实施的结构调整（元素类型注册统一、领域层独立、
能力审批声明化、路由顺序显式化、数据访问层统一、大文件拆分、状态订阅选择器化），
连同每项的理由、风险、依赖顺序与分阶段实施方案，见
[架构调整方案](../plan/architecture-refactor-plan.md)。

## 五、怎么验证

```bash
pnpm typecheck      # 12 个工程全部通过
pnpm lint           # 1514 个文件格式正确，1382 个文件无 lint 错误
pnpm test           # 571 个文件 / 4460 个用例通过
pnpm build          # 首页首屏 JS gzip 173.15 KiB（门禁 300 KiB）
```
