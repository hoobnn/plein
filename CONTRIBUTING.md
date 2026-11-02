# 参与开发

## 环境

- Node ≥ 24（版本写在 `.node-version`）；pnpm 版本由 `package.json` 的 `packageManager` 锁定
- ffmpeg / ffprobe：生成视频封面、音频波形和导出成片都要用到；烧字幕需要带 libass 的构建

```bash
npm i -g pnpm@12
pnpm install
pnpm dev                 # 前端 http://localhost:5173 + 服务端 :8787（数据在 ./data）
```

性能演示画布不依赖服务端：`http://localhost:5173/#/demo?n=5000`。

复制工作区时不要复制 `node_modules/.bin`：pnpm 生成的启动脚本可能保留原工作区路径，原目录删除后会出现 `Cannot find module`。已有依赖本体仍在但普通安装没有重新链接时，可在仓库根目录按当前锁文件强制重建链接：

```bash
pnpm install --offline --frozen-lockfile --ignore-scripts --force
pnpm typecheck
```

离线修复要求包已在本机缓存；它不升级锁定版本，也不执行依赖构建脚本。修复后应从各工作区运行原来的 `vp`、`tsx` 等命令验收，不能只用绝对路径绕过。不要手动把临时目录写回启动脚本。

## 常用命令

| 命令                      | 作用                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm lint`               | Vite+ 检查（Oxfmt 格式 + Oxlint 规则）加 markdownlint                                                    |
| `pnpm format`             | 格式化代码，并应用能安全自动修复的规则，包括 markdownlint 能自动修的项                                   |
| `pnpm typecheck`          | 全部包的类型检查                                                                                         |
| `pnpm test`               | Vitest 单测与集成测试                                                                                    |
| `pnpm test:coverage`      | 统计全部应用及公共包源码覆盖率，执行覆盖率门槛，输出 `coverage/index.html` 与 JSON 汇总                  |
| `pnpm test:e2e-lifecycle` | 用最小 Playwright 服务验证自动目录所有权及成功、失败、中断后的回收                                       |
| `pnpm smoke`              | 启动真实服务，经 HTTP 和 Yjs WebSocket 读写，重启后确认数据没丢                                          |
| `pnpm verify`             | 依次运行 lint、typecheck、桌面 test:profile、E2E 生命周期合同、test:coverage、smoke，pre-push 与 CI 共用 |
| `pnpm e2e`                | Playwright 界面冒烟：基于 mock 平台覆盖关键创作旅程及桌面更新界面，按文件并行                            |
| `pnpm e2e:core`           | 只跑标记为 `@core` 的核心用例：主创作流程、导入导出、协作基础与关键恢复，不含桌面更新独立验收            |
| `pnpm e2e:auth`           | 密码登录回归：真实账号创建、登录退出、会话失效与界面恢复，使用隔离数据库                                 |
| `pnpm e2e:file`           | 只跑指定文件：`pnpm e2e:file e2e/canvas-interaction.spec.ts`                                             |
| `pnpm e2e:grep`           | 按用例标题筛选：`pnpm e2e:grep "新建画布"`                                                               |
| `pnpm e2e:fail`           | 只重跑上一轮失败的用例                                                                                   |
| `pnpm perf`               | 画布渲染性能基准                                                                                         |
| `pnpm perf:compare`       | 在同一 runner 顺序构建和测量基线、候选，比较完整样本并拒绝明显回退                                       |

本地检查由 git 钩子（husky）完成，`pnpm install` 时自动装好：pre-commit 运行 `vp staged`，只格式化、检查暂存文件；pre-push 运行 `pnpm verify`，改了 `package.json` 或 `pnpm-lock.yaml` 时再跑 `pnpm audit:deps`。推送 main 不触发云端 CI，云端只在 Dependabot PR、打 `v*` 标签发版和手动运行（Actions → CI → Run workflow）时跑检查与性能（perf）；发版说明写在 `docs/releases/v<x>/v<x>.<y>/v<x>.<y>.<z>.md`，打标签时自动用作 Release 正文；依赖安全检查另有每周定时。急用可 `git push --no-verify` 跳过钩子，之后在 Actions 里手动补跑一次 CI。

E2E 只在本地跑，云端不再跑：发版前运行 `pnpm e2e:core`，核心冒烟全绿才打标签。测试选层、新增 e2e 的准入规则与独立验收范围见 [测试指南](docs/dev/testing.md)。

```bash
pnpm e2e                          # 主配置全量浏览器回归，并行跑
pnpm e2e:core                     # 发版前冒烟：只跑 @core 的核心用例
pnpm e2e:auth                     # 密码登录回归，隔离数据库
pnpm e2e:file e2e/canvas-interaction.spec.ts  # 只跑指定的文件
pnpm e2e:grep "新建画布"           # 按用例标题筛选
pnpm e2e:fail                     # 只重跑上一轮失败的用例
```

E2E 按文件并行：每个 worker 带一份自己的后端（独立端口 + 独立数据目录），文件之间并行、文件内部串行（一条用例走完整条流水线，状态前后相依）。默认并行度取核数的一半，可用 `PLEIN_E2E_WORKERS` 覆盖。默认由系统分配空闲端口；显式设置 `PLEIN_E2E_BASE_PORT` 时，每个 worker 占用从 `基准 + worker 序号 × 64` 开始的独立端口区间。并行运行若指定基准，应按 worker 总数预留互不重叠的区间。

前端产物按源码哈希缓存：`pnpm e2e` 只在 `apps/web` 或 `packages` 的源码变了才重建 `dist-e2e`，没变就直接复用。强制重建用 `node scripts/build-e2e-web.mjs --force`，完全跳过用 `PLEIN_E2E_BUILD=0`。

每轮运行的数据目录包含仓库标识、运行标识和 worker 序号，失败截图与 trace 也按运行隔离。用例里 `process.env.PLEIN_E2E_DATA` 指向当前 worker 的数据目录；`PLEIN_E2E_DATA_ROOT` 可覆盖自动目录的父目录。

### 验收分层

代码合并不等于能力交付，每层都要留下证据，缺哪层就写「未验收」：

| 层          | 做什么                                                                                          | 门槛                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| L1 单元     | 纯函数：差异计算、参数校验、ffmpeg 参数拼装、缓存键                                             | 新增逻辑有对应用例；边界与错误分支有用例                       |
| L2 集成     | mock Provider（`PLEIN_MOCK_PROVIDER=1`）完整验证节点运行、缓存、导出；媒体加工用本机真实 ffmpeg | 端到端状态与产物断言通过，不靠日志人工判断                     |
| L3 运行冒烟 | 真实起服务按用户路径走一遍，`pnpm smoke` 是其中的自动化部分                                     | 关键路径可用；失败有可执行提示                                 |
| L4 真实样例 | 真实平台调用与人工回放（`e2e/playwright.l4.config.ts`）                                         | **需要用户授权与密钥**，默认不做；未做就写「未验收（待授权）」 |

L1–L3 是合并门禁，L4 是发布门禁。mock 通过不能替代 L4；流程验收与成片质量验收分开记录。

工具链是 [Vite+](https://viteplus.dev)（命令 `vp`）：Oxfmt 负责格式化代码、样式、Markdown、YAML 和 HTML，Oxlint 做代码检查（含类型感知规则），Vitest 运行单元测试，`vp pack`（tsdown）打包服务端和桌面端。规则和格式选项都写在根目录的 `vite.config.ts`。

覆盖率包括未被测试导入的 `apps/*/src` 和 `packages/*/src` 源码，只排除测试、类型声明、生成代码及测试辅助文件。桌面端也属于测试项目。CI 和 `pnpm verify` 使用同一套覆盖率门槛：全局底线防止回退，调度、输入准备、列表快照及桌面状态模块另设更高门槛。单元测试覆盖率和浏览器端到端测试分别计数，不能把 mock 平台通过解释为真实平台验收。门槛数值写在根目录的 `vite.config.ts`。

E2E 自动数据目录在启动服务时独占创建，服务停止后回收；`--list` 不建目录。显式设置 `PLEIN_E2E_DATA` 的目录由调用者管理，测试失败或中断后仍保留。目录监护支持 macOS/Linux；监护进程自身遭 `SIGKILL` 或机器崩溃不保证回收。

性能比较需要两份独立检出和各自 lockfile 对应的依赖。设置 `PERF_BASE_ROOT=/path/to/baseline pnpm perf:compare`；默认基线为候选提交之前最近的 `v*` tag，可用 `PERF_BASE_REF=<tag-or-commit>` 指定，检出必须与之匹配且干净。CI 自动创建基线 worktree 并安装锁定依赖，本地命令不安装依赖。两份产品都由当前候选的测量脚本、同一 Chromium 和参数顺序测量，输出 `test-results/perf-comparison/{baseline,candidate,comparison}.json`；环境、实际夹具摘要、全部场景或三轮原始样本不符均失败。只验证已生成报告可用 `pnpm perf:compare --reports baseline.json candidate.json`。单版本诊断仍用 `pnpm perf`；formatVersion 1 历史报告不能充当新门禁基线。

格式化遵循 `.gitignore`，排除构建产物；`pnpm-lock.yaml` 保留 pnpm 自己生成的格式。Markdown 段落不强制折行，代码块和 HTML 里内嵌的代码不做二次格式化。Markdown 规则另由 markdownlint 检查，配置在 `.markdownlint.jsonc`，VS Code 的 markdownlint 插件读取同一份配置。

## 代码结构

```text
apps/web               Vite + React 19 + Tailwind v4 前端
apps/server            本地服务：Hono（Node）+ SQLite + Yjs 同步 + 资产 + 任务队列 + Better Auth
apps/desktop           Electron 外壳，在 utilityProcess 里运行 apps/server
packages/canvas-core   画布内核：PixiJS v8 + 相机 + 输入
packages/doc           文档模型：Yjs（Element / Edge / Undo）
packages/flow          工作流：依赖图、执行顺序、按依赖调度、缓存键
packages/nodes         内置节点声明（plein/core）、短剧模板与提示词
packages/capabilities  画布能力层：界面、⌘K、智能体和对外 MCP 共用
packages/protocol      前后端共享的接口约定（zod）
packages/plugin-sdk    插件 API：清单、节点、Provider、执行器
packages/providers     模型平台适配器（服务端）：MiniMax、豆包语音、百炼、火山方舟及 mock
```

应用内部按领域组织：

```text
apps/web/src
  canvas/      画布接线与元素操作：CanvasView、节点卡片、覆盖层、导入、宫格、分组
  shell/       编辑器外壳：工具栏、侧栏、菜单、选区条、结果条、命令面板
  features/    功能域，组件、store 与领域逻辑放在一起：agent、library、sequence、
               storyboard、generator、runs、templates、settings、projects、onboarding
  stores/      跨功能的全局状态：canvas、catalog、session、sidebar、theme、assetMeta
  ui/          通用控件，不含业务流程
  pages/       路由页面：Home、Editor、Login、ProjectOpen
apps/server/src
  <领域>/      每个领域一个目录，路由统一叫 routes.ts：agent、assets、canvases、library、
               mcp、plugins、projects、prompt、runs、sync、templates
  http/        HTTP 基础设施：来源校验、文件响应
  storage/     SQLite schema、迁移与数据访问
```

包之间的依赖只能自上而下：`apps/*` → `capabilities` / `providers` / `protocol` → `nodes` / `canvas-core` / `flow` → `doc` / `plugin-sdk`。`doc`、`canvas-core`、`flow`、`nodes` 不依赖 React 和 Node 专属 API，前后端、Worker 和测试都能直接用。

设计取舍见 [architecture.md](docs/dev/architecture.md)，界面规范见 [design-spec.md](docs/dev/design-spec.md)。几条硬约束：

- 相机与渲染不走 React state，拖动 / 缩放期间 React 零重渲染
- 二进制资源不进 Yjs 文档，只存 assetId
- GPU 画内容，DOM 覆盖层负责编辑与表单（按 LOD 挂载）

### 结构调整约定

下面几条是改结构时共同遵守的约定，来源与背景见[架构调整方案](docs/plan/architecture-refactor-plan.md)。

- **元素类型注册**：新增节点类型只在 `packages/nodes` 声明；需要专门的打开行为或编辑器时，在前端节点注册表登记（注册表由方案 A2 建立，未建立前沿用现有分发处）。不要新增 `ElementKind`，除非是新的媒体类元素。
- **能力审批**：能力的副作用等级用 `effect` 声明；不要在 `apps/server/src/agent/tools.ts` 或 `approvals.ts` 里按能力名加特判。
- **路由顺序**：路径形状互相覆盖的路由要有专门的回归用例，见 `apps/server/src/media-index/route-order.test.ts`。
- **数据访问**：Drizzle 查询放在存储模块（`store.ts` / `*-store.ts` / `storage/` 目录）；路由文件里不直接写库。检查用例见 `apps/server/src/storage/data-access.test.ts`，它扫全部路由文件（`routes.ts` 与 `*-routes.ts`），出现 Drizzle import 或 `db.insert` / `db.update` / `db.delete`（含事务里的 `tx.`）就失败；确需例外时写进该文件的 `ALLOWED` 并写明理由。
  - 基础设施直连（保留直连，文件头已写明理由）：`apps/server/src/auth/index.ts`（Better Auth 的适配器要接同一个 db 实例与认证表 schema，账号表与业务表共用一份迁移）、`apps/server/src/sync/rooms.ts`（协作房间的增量写入要走预编译语句的热路径，写增量与更新画布时间戳必须同事务）。
  - 待收项（直连暂不收，下一波整体拆分时一并处理）：`apps/server/src/agent/sessions.ts`、`apps/server/src/projects/package.ts`。
- **前端依赖**：优先复用已有依赖，已有依赖能表达的组件和行为不自己实现；新增前端依赖前先看 [architecture-refactor-plan.md](docs/plan/architecture-refactor-plan.md) §3.I 的选型表，同一用途不引第二个库；跨包共用的依赖版本写在 `pnpm-workspace.yaml` 的 `catalog:`。

## 桌面端

```bash
pnpm dev:desktop         # Vite + Electron；服务端直接运行源码，接口经 Vite 代理到 :8787
pnpm start:desktop       # 先构建服务端和前端，再用构建产物启动（与安装包的运行方式一致）
pnpm dist:desktop        # 出 macOS 安装包（Apple 芯片），没有证书时 ad-hoc 签名
```

桌面端保留系统原生标题栏和窗口按钮：macOS 使用系统菜单栏、⌘ 快捷键，关闭窗口后应用继续运行，可从 Dock 重开；Windows 使用窗口菜单栏、Ctrl 快捷键和系统窗口布局，关闭最后一个窗口即退出。菜单中的撤销、重做和全选会作用于当前画布或文本编辑器，设置可用 `CmdOrCtrl+,` 打开。窗口位置、尺寸和最大化状态保存在应用数据目录的 `window-state.json`；显示器变化时会将窗口移回可见工作区。开发工具菜单仅在开发模式显示。

首次运行会下载 Electron。服务端只接受桌面端窗口的请求（每次启动生成的令牌放在窗口 Cookie 里），所以开发模式下用普通浏览器打开 5173 会返回 403。ffmpeg 构建、打包和签名发布见[桌面端文档](docs/dev/desktop.md)。

## 发版说明

每个标签对应一份发版说明，按主版本、次版本两级目录存放：`v0.9.4` 写在 `docs/releases/v0/v0.9/v0.9.4.md`，打标签时作为 Release 正文，也是应用内更新面板显示的说明。只写用户能感知的变化，测试、CI、内部重构和验收过程写进提交消息。结构固定为：

1. 首行 `<!-- markdownlint-disable-file MD041 -->`。
2. 有升级须知（能否自动更新、是否需要手动安装、数据兼容性）时，加一段 `> [!NOTE]`。
3. 一段以「本版」开头的导语，概括主要变化。
4. 依次是 `## 新增`、`## 优化`、`## 修复`、`## 使用说明`，没有内容的章节省略，不另起其他章节。

新增和优化的条目写成 `- **短标题**：说明。`；修复的条目不加粗，写成 `- 修复……的问题。`，需要时再用分号补充现在的行为。用户可感知的依赖或安全升级并入优化或修复。使用说明用段落写计费、前置条件、能力边界和尚未在真实平台验收的部分。

## 分支

分支名遵循 [Conventional Branch](https://conventionalbranch.org/)：`<type>/<description>`，全小写，单词之间用连字符。

- type 可选 `feature`/`feat`、`bugfix`/`fix`、`hotfix`、`release`、`chore`；AI 代理自己建的分支用 `claude/`、`codex/`、`copilot/`、`cursor/`、`ai/`
- 主干 `main` 不加前缀
- 示例：`feature/add-login-page`、`fix/edge-hit-test`、`release/v1.2.0`

命名规则有三道关卡：本地由 husky `pre-push` 拦截；GitHub 规则集（`.github/rulesets/conventional-branch.json`）不允许创建前缀不合规的分支；PR 分支再由 `Branch name` CI 用完整正则校验一遍。

Dependabot 自动创建的 `dependabot/*` 分支是保留的例外，PR 检查会同时核验作者必须为 `dependabot[bot]`；手动使用该前缀创建的 PR 仍会被命名检查拒绝。

## 提交

提交信息的格式是 `<emoji> type(scope): 中文描述`，例如 `✨ feat(canvas): 新增小地图`。type 和 emoji 一一对应，由 husky `commit-msg` 钩子里的 commitlint 校验，完整对照表见 `commitlint.config.cjs`。

## 依赖检查

- Dependabot 每周一北京时间 09:00 检查整个 pnpm workspace 和 GitHub Actions，有更新时自动创建 PR。生产依赖和开发依赖的 minor / patch 各自分组更新，major 单独评审；所有更新都不自动合并。
- `Dependency security / dependency-review` 检查 PR 新引入的依赖，带进 high / critical 漏洞就失败。
- `Dependency security / dependency-audit` 用原生 `pnpm audit` 检查整份锁文件，生产、开发和间接依赖都覆盖到。它在 PR、推送 main、每周定时和手动触发时运行；发现 high / critical 漏洞就阻断，审计服务本身报错也按失败处理。本地可以运行 `pnpm audit:deps`。

pnpm 12 的锁文件包含多份 YAML 文档，上游的依赖图解析对此还有[兼容问题](https://github.com/dependabot/dependabot-core/issues/15904)，所以保留原生审计来补足依赖图覆盖不到的部分。两项检查都基于已知漏洞数据库，通过不代表依赖风险已经全部排除。要真正阻止带漏洞的 PR 合并，还需要在 main 的合并规则里把这两个 job 设为必需检查。
