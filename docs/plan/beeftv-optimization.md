# BeefTV 对照驱动的全面优化

2026-10-17。基线：Plein `056dc4d`、BeefTV `cfbe1ffd83438ff6d0691a653041ee958a69dc84`。状态：十个工作包全部落地，本地集成验收通过。

## 目标与合同

沿用 PixiJS、Yjs、SQLite、CapabilityRegistry 和 PluginHost。全部交付范围包括稳定参考顺序、Agent 执行与上下文、媒体性能、按需加载、提示词草稿、候选审片、分镜审核、模型选择、跨画布素材检索、命名检查点和项目包迁移。

源码对照是设计依据，不是双方运行性能对比。既有 W1–W5 与 E1 不重复立项；真实生成质量和 mock 流程验收分开。

## 工作包与验收台账

| 工作包          | 完成条件                                                                 | 状态与证据                                                   |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| R1 稳定输入     | schema v3 固化旧顺序；移动上游不改变输入；重排/替换/撤销与前后端一致     | 完成；迁移、布局不改输入、显式重排/替换与上传竞争通过        |
| R2 Agent 轮次   | 每轮独立凭据与进程、异步写入 guard、旧轮不能写入新轮、重启清算           | 完成；每轮隔离、迟到写入 guard 与中断清算通过                |
| R3 Agent 上下文 | 工具与审批事实持久化、合法分页、请求预算、声明式视觉通路                 | 完成；完整轮次、合法分页、文本/图片预算与 vision mock 通过   |
| R4 画布媒体     | 细节正确首载、内容不重建几何、共享纹理 lease、离屏回收、视频首帧和重试   | 完成；共享 lease、首载细节、离屏/退出释放及播放器通过        |
| R5 加载与测量   | 首页 JS gzip ≤300 KiB；真实媒体首屏、生命周期及同环境回归门禁            | 完成；首页 212.58 KiB，冷热各三轮与全部五个交互场景通过      |
| R6 创作编辑     | 提示词建议先审后采用、大编辑器、候选只预览、明确采用、图片 A/B           | 完成；草稿采用冲突、放大编辑、A/B 与按钮 Enter 回归通过      |
| R7 逐镜审核     | 分镜图/视频/配音/任务逐行可见、选中/未完成运行、失败恢复；模型搜索与近期 | 完成；逐节点最新任务、默认沿用、选中范围及所有恢复出口通过   |
| R8 素材检索     | owner 隔离、项目与类型筛选、分页、多来源去重、旧数据补建、画布复用       | 完成；隔离、分页、补建、写入故障退避与跨画布复用通过         |
| R9 检查点       | 新增/删除同步屏障、命名保存、只读预览、新画布恢复、历史关联与素材 pin    | 完成；删除屏障、只读预览、原画布保留、新画布恢复与 pins 通过 |
| R10 迁移与文档  | manifest v2 携带检查点及独有素材、v1 兼容、导入回滚、索引与架构同步      | 完成；真实缺字段 v1、v2 独有素材、损坏包回滚和文档已覆盖     |

## 固定默认值

- 参考：新连线追加；显式重排才改变语义；首尾帧用途可见。候选箭头与历史缩略图只预览，点击采用或 Enter 才更新下游。
- Agent：每轮 30 次模型请求、100 次工具；单分页 24 KiB、单工具文本 32 KiB、请求文本 128 KiB。历史按完整轮次淘汰。每轮累计最多 8 张图、单图 1 MiB、合计 4 MiB，仅使用声明 tools + vision 的模型。
- 媒体：4 并发、512 MiB 来源纹理估算软预算、128 闲置纹理、30 秒 TTL；离屏 body 保留 2 秒、最多额外 256 个。仅淘汰零引用项，活跃资源超预算如实记录。
- 检索：默认每页 50、最多 100；assets 为库存事实来源、来源索引可重建。删除来源不删除媒体；本轮不增加垃圾回收。
- 检查点：手动命名；保存包含删除集的 Yjs Snapshot 屏障；只恢复为同项目新画布；活动任务不复制。删除原画布保留检查点，删除项目一并删除检查点。
- 项目包：有检查点写 v2；新 reader 接收 v1；命名检查点不受当前候选裁剪选项影响。

## 验证与交付规则

每包通过对应行为测试后集成。最终执行 `pnpm verify`、`pnpm build`、`pnpm e2e`、`pnpm perf`，记录运行版本和结果，不以窄测试替代整包验收。

性能 fixture 使用真实入库的图片和视频封面，预览失败不能判首屏成功。报告分 engine-ready、first-visible-preview、visible-media-settled，记录 commit、fixture、runtime、平台与渲染器。只比较相同环境；首预览同时退化 >50% 且 >100ms、每帧 JS 同时退化 >50% 且 >2ms 时失败。2026-10-23 起 CI 同 runner 重新测量基线与候选，基线缺失、样本或夹具不匹配均失败；资源生命周期断言继续作为硬门禁。

不新增供应商，不扩展完整动态 3D，不替换渲染引擎。源码落地、自动测试、界面运行、真实平台与人工审片分别记录。

## 复现入口

`pnpm verify` 覆盖格式、类型、单测和服务端 smoke；`pnpm build` 附带首页 gzip 门禁；`pnpm e2e` 用真实服务、mock 平台和 Chromium 运行完整界面流程。

`PERF_OUTPUT=/private/tmp/plein-perf.json pnpm perf` 默认用 1000 个元素、32 个唯一图片和真实视频/音频资产，冷开与热开各三轮，并运行全部交互场景。报告包含源码提交、未提交状态、构建指纹、Node/Chromium/渲染器、实际媒体与 demo 摘要和每轮样本。单次诊断可用 `PERF_BASELINE` 比较已存在的 formatVersion 2 报告；CI 使用 `pnpm perf:compare`，在同一 runner 重测候选提交之前最近的版本 tag（可覆盖），不借用历史机器报告。完整用法见[开发约定](../../CONTRIBUTING.md)。SwiftShader 结果不代表硬件 GPU 帧率。CI 将两份样本及比较结果保留为 `canvas-perf` artifact，失败也写诊断 JSON。

各专项数可能覆盖相同测试，不能直接相加为全量总数。Agent 的真实账号 CLI、真实模型视觉和生成质量不在本轮 mock 验收结论中。

## 本地集成验收

观察日期：2026-10-17；源码基点 `056dc4d`，本轮改动尚未提交。功能流程使用真实本机服务与 mock 平台；媒体 fixture 经真实上传、衍生物生成和 Chromium 呈现。

| 检查          | 结果                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `pnpm verify` | 95 个测试文件通过，798 项通过、1 项按运行环境条件跳过；格式、类型与服务 smoke 通过  |
| `pnpm build`  | 通过；首页静态 JS gzip 212.58 KiB，共 16 个 chunk，门槛 300 KiB                     |
| `pnpm e2e`    | 通过；65 条界面流程全部通过，含本轮新增的创作、媒体、检查点与恢复用例               |
| `pnpm perf`   | 通过；1000 元素，冷热各 3 轮、全部 5 个交互场景；无历史同环境基线，时间仅作本轮样本 |

完整性能样本见 [JSON 报告](../benchmarks/2026-10-17-canvas-perf.json)。环境为 Node 26.12.0、Chromium 156.0.8078.4、darwin/arm64、1440×900，渲染器为 SwiftShader；构建指纹与每轮样本保存在报告里。首预览中位数为冷开 748.6 ms、热开 595.8 ms；引擎就绪分别为 474.9 ms、94.8 ms。每轮 1000 个媒体全部呈现、HTTP/预览/runtime 失败为零；34 个唯一纹理估算来源像素 7,397,632 bytes。交互的每帧 JS 中位数为平移 0.75 ms、缩放 4.28 ms、选中素材平移 0.78 ms、拖动 12 个元素 1.93 ms、20 个节点运行时静止 0.06 ms。

数据故障回归包含：文档和媒体投影同事务回滚并保留缓冲重试；卸载快照失败保留房间；任务 journal/资产库已保存时投影故障不改写成功结果；删除来源时索引故障不阻断房间关闭；后台补建关闭取消及失败退避。任务恢复覆盖超过最近 100 条窗口、取消后核查原任务，以及无法重新查询时明确标记已处理后继续。

操作说明见 [创作、审片与复用](../guide/creation-review.md)、[智能体与 MCP](../guide/agent.md)。本次没有真实平台生成质量、真实账号 CLI 或硬件 GPU 的验收结论，也没有双方运行速度对比。新增 CI 门禁已写入工作流；远端 CI 运行结果需代码提交后另行取得。

## 关键行为回归入口

- 稳定输入：[文档顺序与迁移](../../packages/doc/src/inputs.test.ts)、[服务实际输入](../../apps/server/src/runs/preview.test.ts)、[前端读取](../../apps/web/src/canvas/nodes.test.ts)。
- Agent：[轮次与上下文](../../apps/server/src/agent/reliability.test.ts)、[异步写入保护](../../apps/server/src/agent/guard-integration.test.ts)、[视觉通路](../../apps/server/src/agent/vision-integration.test.ts)、[有界字段读取](../../packages/capabilities/src/read-view.test.ts)。
- 媒体：[共享纹理](../../packages/canvas-core/src/textures.test.ts)、[离屏回收](../../packages/canvas-core/src/views.test.ts)、[播放器](../../apps/web/src/canvas/player.test.ts)、[真实媒体与失败门禁](../../e2e/canvas-media.spec.ts)。
- 创作与恢复：[创作界面](../../e2e/creation-review.spec.ts)、[任务恢复服务](../../apps/server/src/runs/recovery.test.ts)、[恢复界面](../../e2e/recovery-actions.spec.ts)。
- 素材与迁移：[索引/检查点与故障注入](../../apps/server/src/checkpoints/features.test.ts)、[同步保存客户端](../../apps/web/src/features/checkpoints/client.test.ts)、[项目包](../../apps/server/src/projects/package.test.ts)、[跨项目界面](../../e2e/media-checkpoints.spec.ts)。
